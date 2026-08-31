import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { GFM } from './gfmTableFix';
import { readTableModel } from './livePreviewPlugin';

/** Parses markdown through the app's GFM config and reads its first table. */
function modelFor(markdownText: string) {
	const state = EditorState.create({ doc: markdownText, extensions: [markdown({ extensions: GFM })] });
	const tree = ensureSyntaxTree(state, state.doc.length, 5000);
	if (!tree) throw new Error('syntax tree did not finish parsing in time');
	let table: SyntaxNode | null = null;
	tree.iterate({
		enter(node) {
			if (!table && node.name === 'Table') table = node.node;
		},
	});
	if (!table) throw new Error('no table parsed');
	return readTableModel(state, table);
}

describe('readTableModel', () => {
	describe('column alignment', () => {
		it('reads left, center and right specs from the delimiter row', () => {
			expect(modelFor('| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n').align).toEqual([
				'left',
				'center',
				'right',
			]);
		});

		it('leaves a column with no colon unaligned', () => {
			expect(modelFor('| a | b |\n|---|:-:|\n| 1 | 2 |\n').align).toEqual([null, 'center']);
		});

		it('reads alignment written without the outer pipes', () => {
			expect(modelFor('a | b\n:-- | --:\n1 | 2\n').align).toEqual(['left', 'right']);
		});

		it('tolerates padding around the specs', () => {
			expect(modelFor('| a | b |\n|  :---:  |  ---:  |\n| 1 | 2 |\n').align).toEqual(['center', 'right']);
		});
	});

	describe('ragged rows', () => {
		// GFM fixes a table's column count at the delimiter row: shorter rows are
		// padded with empty cells and any overflow is discarded. Rendering rows at
		// their own natural width produced a visibly ragged table.
		it('pads a row that has fewer cells than the header', () => {
			const { rows } = modelFor('| a | b | c |\n|---|---|---|\n| 1 |\n');
			expect(rows).toEqual([
				['a', 'b', 'c'],
				['1', '', ''],
			]);
		});

		it('drops the overflow of a row that has more cells than the header', () => {
			const { rows } = modelFor('| a | b |\n|---|---|\n| 1 | 2 | 3 | 4 |\n');
			expect(rows).toEqual([
				['a', 'b'],
				['1', '2'],
			]);
		});

		it('normalizes short and long rows in the same table', () => {
			const { rows } = modelFor('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |\n');
			expect(rows).toEqual([
				['a', 'b', 'c'],
				['1', '', ''],
				['1', '2', '3'],
			]);
		});

		it('reports exactly one header row', () => {
			expect(modelFor('| a |\n|---|\n| 1 |\n| 2 |\n').headerRowCount).toBe(1);
		});

		it('keeps a header-only table (no data rows)', () => {
			const { rows, headerRowCount } = modelFor('| a | b |\n|---|---|\n');
			expect(rows).toEqual([['a', 'b']]);
			expect(headerRowCount).toBe(1);
		});
	});

	it('keeps an interior empty cell in place rather than shifting later columns left', () => {
		// Regression guard: @lezer/markdown emits no TableCell node for an empty
		// cell, so reading cells via getChildren would drop it.
		const { rows } = modelFor('| a | b | c |\n|---|---|---|\n| 1 |  | 3 |\n');
		expect(rows[1]).toEqual(['1', '', '3']);
	});
});
