import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
	cursorTouchesRange,
	blockCursorTouchesRange,
	setPointerDownForTesting,
	setSuppressForTesting,
	allowRevealOnce,
	noteRevealed,
	clearRevealedForTesting,
} from './cmUtils';

const DOC = 'above\n| a | b |\n|---|---|\n| 1 | 2 |\nbelow\n';

/** Range of the table block in DOC (lines 2-4). */
function tableRange(state: EditorState): { from: number; to: number } {
	return { from: state.doc.line(2).from, to: state.doc.line(4).to };
}

function stateWithSelection(anchor: number, head = anchor): EditorState {
	return EditorState.create({ doc: DOC, selection: { anchor, head } });
}

describe('cursorTouchesRange', () => {
	beforeEach(() => {
		setPointerDownForTesting(false);
		setSuppressForTesting(false);
	});

	it('is true for a caret on a line inside the range', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		expect(cursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
	});

	it('is false for a caret outside the range', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		expect(cursorTouchesRange(stateWithSelection(1), from, to)).toBe(false);
	});

	// Sweeping a selection across a rendered block is a copy gesture. Unrendering
	// it mid-sweep replaces the rows being selected with raw pipe text and loses
	// the selection the user was making.
	it('ignores a non-empty selection whose head lands inside the range', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const head = state.doc.line(3).from + 2;
		expect(cursorTouchesRange(stateWithSelection(0, head), from, to)).toBe(false);
	});

	// A blank line above a table resolves to document position 0, so pressing
	// there and dragging down reads as a plain caret move whose head lands inside
	// the table — indistinguishable from a click on it. Suppressing while the
	// button is held is what keeps the block from flipping to source mid-gesture.
	// The mouse-gesture guards live in `blockCursorTouchesRange`, not here.
	// `cursorTouchesRange` also decides whether a heading shows its `#` and
	// whether `**bold**` shows its asterisks; guarding it meant clicking a
	// heading moved the caret but left the markup hidden, so the line could not
	// be edited by mouse at all.
	it('ignores the mouse-gesture guards, which are not its concern', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setPointerDownForTesting(true);
		setSuppressForTesting(true);
		expect(cursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
	});
});

describe('blockCursorTouchesRange', () => {
	beforeEach(() => {
		setPointerDownForTesting(false);
		setSuppressForTesting(false);
		clearRevealedForTesting();
	});

	it('agrees with cursorTouchesRange when no gesture is in play', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
		expect(blockCursorTouchesRange(stateWithSelection(1), from, to)).toBe(false);
	});

	// A blank line above a table resolves to document position 0, so pressing
	// there and dragging down reads as a plain caret move whose head lands inside
	// the table — indistinguishable from a click on it. Suppressing while the
	// button is held keeps the block from flipping to source mid-gesture.
	it('is false while a mouse gesture is in progress', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setPointerDownForTesting(true);
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(false);
	});

	it('reveals the source again once the gesture ends', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setPointerDownForTesting(true);
		setPointerDownForTesting(false);
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
	});

	it('suppresses the reveal for a caret dragged into a block', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setSuppressForTesting(true);
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(false);
	});

	// A block already showing its source must keep showing it whatever the mouse
	// does. Applying the guards to one that is already open made it flip back to
	// its rendered form for an instant on every click inside it — visible as the
	// source flashing to a table while it was being edited.
	it('keeps a block open once its source is already showing', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		noteRevealed(from, to, true);
		setSuppressForTesting(true);
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
		setPointerDownForTesting(true);
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
	});

	it('stops exempting a block once it is rendered again', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		noteRevealed(from, to, true);
		noteRevealed(from, to, false);
		setSuppressForTesting(true);
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(false);
	});

	// The exemption must not leak to a block the caret is not in.
	it('does not exempt a block whose range was never revealed', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		noteRevealed(from + 100, to + 100, true);
		setSuppressForTesting(true);
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(false);
	});

	// `allowRevealOnce` is the code-mode button's way past the suppression, since
	// that button's press never reaches the block to clear the flag itself.
	it('lets allowRevealOnce lift the suppression', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setSuppressForTesting(true);
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(false);
		allowRevealOnce();
		expect(blockCursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
	});
});
