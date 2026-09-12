import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { selectionDecorationRanges } from './decorationRefresh';

describe('selectionDecorationRanges', () => {
	it('includes the owning paragraph when a caret lands on its trailing blank line', () => {
		const doc = 'paragraph\n\nnext';
		const state = EditorState.create({ doc, selection: { anchor: 'paragraph\n'.length } });
		expect(selectionDecorationRanges(state)).toEqual([{ from: 0, to: 'paragraph\n'.length }]);
	});

	it('keeps ordinary non-blank cursor invalidation on the current line', () => {
		const doc = 'paragraph\n\nnext';
		const nextFrom = doc.indexOf('next');
		const state = EditorState.create({ doc, selection: { anchor: nextFrom + 1 } });
		expect(selectionDecorationRanges(state)).toEqual([{ from: nextFrom, to: doc.length }]);
	});
});