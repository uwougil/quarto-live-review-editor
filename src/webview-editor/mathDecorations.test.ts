import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { mathDecorationsField } from './mathDecorations';
import { mathRangesField } from './math';

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
		const ranges: Array<{ from: number; to: number }> = [];
		decorations.between(0, state.doc.length, (from, to) => { ranges.push({ from, to }); });
		expect(ranges).toHaveLength(2);
		expect(ranges).toEqual([{ from: 0, to: 15 }, { from: 22, to: 25 }]);
	});

	it('leaves a partial-line multi-line display expression editable', () => {
		const state = EditorState.create({
			doc: 'prefix $$\nx = y\n$$',
			extensions: [mathRangesField, mathDecorationsField],
		});
		expect(state.field(mathDecorationsField).size).toBe(0);
	});
});
