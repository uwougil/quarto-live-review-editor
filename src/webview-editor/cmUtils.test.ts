import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { cursorTouchesRange, setPointerDownForTesting, setSuppressForTesting, allowRevealOnce } from './cmUtils';

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
	it('is false while a mouse gesture is in progress', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setPointerDownForTesting(true);
		expect(cursorTouchesRange(stateWithSelection(inside), from, to)).toBe(false);
	});

	it('reveals the source again once the gesture ends', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setPointerDownForTesting(true);
		setPointerDownForTesting(false);
		expect(cursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
	});

	// The suppression is what keeps a rendered block from flipping to source on a
	// stray click; `allowRevealOnce` is the code-mode button's way past it, since
	// that button's press never reaches the block to clear the flag itself.
	it('lets allowRevealOnce lift the suppression', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setSuppressForTesting(true);
		expect(cursorTouchesRange(stateWithSelection(inside), from, to)).toBe(false);
		allowRevealOnce();
		expect(cursorTouchesRange(stateWithSelection(inside), from, to)).toBe(true);
	});

	it('suppresses the reveal for a caret dragged into a block', () => {
		const state = stateWithSelection(0);
		const { from, to } = tableRange(state);
		const inside = state.doc.line(3).from + 2;
		setSuppressForTesting(true);
		expect(cursorTouchesRange(stateWithSelection(inside), from, to)).toBe(false);
	});
});
