import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { mathDecorationsField } from './mathDecorations';
import { mathRangesField } from './math';

function mathDecorationRanges(state: EditorState): Array<{ from: number; to: number }> {
	const ranges: Array<{ from: number; to: number }> = [];
	state.field(mathDecorationsField).between(0, state.doc.length, (from, to) => { ranges.push({ from, to }); });
	return ranges;
}

describe('math decorations', () => {
	it('stores a multi-line display formula as a valid block decoration field', () => {
		const state = EditorState.create({
			doc: '$$\nx = y + 1\n$$\n\ntext $z$',
			selection: { anchor: 18 },
			extensions: [mathRangesField, mathDecorationsField],
		});
		const decorations = state.field(mathDecorationsField);
		const iter = decorations.iter();
		const iterated: Array<{ from: number; to: number }> = [];
		while (iter.value) {
			iterated.push({ from: iter.from, to: iter.to });
			iter.next();
		}
		expect(iterated).toEqual([{ from: 0, to: 15 }, { from: 22, to: 25 }]);
		expect(mathDecorationRanges(state)).toEqual([{ from: 0, to: 15 }, { from: 22, to: 25 }]);
	});

	it('keeps a formula rendered when a non-empty selection crosses it', () => {
		const doc = 'before $x+y$ after';
		const state = EditorState.create({
			doc,
			selection: { anchor: 0, head: doc.length },
			extensions: [mathRangesField, mathDecorationsField],
		});
		expect(mathDecorationRanges(state)).toEqual([{ from: 7, to: 12 }]);
	});

	it('reveals formula source only for a collapsed caret inside it', () => {
		const doc = 'before $x+y$ after';
		const state = EditorState.create({
			doc,
			selection: { anchor: 9 },
			extensions: [mathRangesField, mathDecorationsField],
		});
		expect(mathDecorationRanges(state)).toEqual([]);
	});

	it('leaves a partial-line multi-line display expression editable', () => {
		const state = EditorState.create({
			doc: 'prefix $$\nx = y\n$$',
			extensions: [mathRangesField, mathDecorationsField],
		});
		expect(state.field(mathDecorationsField).size).toBe(0);
	});
});