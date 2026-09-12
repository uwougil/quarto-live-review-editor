import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { editingMathRange } from './mathEditPreview';
import { mathRangesField } from './math';

describe('editingMathRange', () => {
	it('returns an inline formula for a collapsed caret inside it', () => {
		const doc = 'before $x+y$ after';
		const state = EditorState.create({ doc, selection: { anchor: doc.indexOf('x') }, extensions: [mathRangesField] });
		expect(editingMathRange(state)).toMatchObject({ tex: 'x+y', display: false });
	});

	it('returns a multiline display formula for a collapsed caret inside it', () => {
		const doc = 'before\n$$\nx + y\n$$\nafter';
		const state = EditorState.create({ doc, selection: { anchor: doc.indexOf('x') }, extensions: [mathRangesField] });
		expect(editingMathRange(state)).toMatchObject({ tex: 'x + y', display: true });
	});

	it('does not preview a non-empty selection or a caret outside math', () => {
		const doc = 'before $x+y$ after';
		const selection = EditorState.create({ doc, selection: { anchor: 0, head: doc.length }, extensions: [mathRangesField] });
		const outside = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [mathRangesField] });
		expect(editingMathRange(selection)).toBeNull();
		expect(editingMathRange(outside)).toBeNull();
	});
});
