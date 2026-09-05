import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { GFM } from './gfmTableFix';
import { readTableModel, sanitizeCellInput, caretPastTable } from './livePreviewPlugin';

function stateFor(markdownText: string): EditorState {
	return EditorState.create({ doc: markdownText, extensions: [markdown({ extensions: GFM })] });
}

/** Parses markdown through the app's GFM config and reads its first table. */
function modelFor(markdownText: string) {
	const state = stateFor(markdownText);
	const tree = ensureSyntaxTree(state, state.doc.length, 5000);
	if (!tree) throw new Error('syntax tree did not finish parsing in time');
	let table: SyntaxNode | null = null;
	tree.iterate({
		enter(node) {
			if (!table && node.name === 'Table') table = node.node;
		},
	});
	if (!table) throw new Error('no table parsed');
	return { state, model: readTableModel(state, table) };
}

describe('cell source ranges', () => {
	// Editing a rendered cell writes the new text over exactly this range, so a
	// range that is off by even one character would eat a pipe or a neighbouring
	// cell's text and corrupt the table.
	it('points at the trimmed text of each cell, not its padding', () => {
		const { state, model } = modelFor('| a | b |\n|---|---|\n| 1 | 2 |\n');
		const sliced = model.cellRanges.map((row) => row.map((c) => (c ? state.sliceDoc(c.from, c.to) : null)));
		expect(sliced).toEqual([
			['a', 'b'],
			['1', '2'],
		]);
	});

	it('keeps ranges aligned when padding is uneven', () => {
		const { state, model } = modelFor('|   wide   |b|\n|---|---|\n|  1 |    2|\n');
		const sliced = model.cellRanges.map((row) => row.map((c) => (c ? state.sliceDoc(c.from, c.to) : null)));
		expect(sliced).toEqual([
			['wide', 'b'],
			['1', '2'],
		]);
	});

	it('gives an empty cell a zero-width range between its pipes', () => {
		const { state, model } = modelFor('| a | b |\n|---|---|\n| 1 |  |\n');
		const empty = model.cellRanges[1][1];
		expect(empty).not.toBeNull();
		expect(empty!.from).toBe(empty!.to);
		// The insertion point must sit between the two pipes that bound the cell.
		expect(state.sliceDoc(empty!.from - 1, empty!.from + 1).includes('|')).toBe(true);
	});

	it('records no range for a cell invented to pad a ragged row', () => {
		const { model } = modelFor('| a | b | c |\n|---|---|---|\n| 1 |\n');
		expect(model.rows[1]).toEqual(['1', '', '']);
		expect(model.cellRanges[1][0]).not.toBeNull();
		expect(model.cellRanges[1].slice(1)).toEqual([null, null]);
	});

	it('reads ranges for a table written without outer pipes', () => {
		const { state, model } = modelFor('a | b\n---|---\n1 | 2\n');
		const sliced = model.cellRanges.map((row) => row.map((c) => (c ? state.sliceDoc(c.from, c.to) : null)));
		expect(sliced).toEqual([
			['a', 'b'],
			['1', '2'],
		]);
	});

	it('reads ranges for a table indented under a list item', () => {
		const { state, model } = modelFor('- w:\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n');
		const sliced = model.cellRanges.map((row) => row.map((c) => (c ? state.sliceDoc(c.from, c.to) : null)));
		expect(sliced).toEqual([
			['a', 'b'],
			['1', '2'],
		]);
	});

	it('spans the whole of a cell holding inline markup', () => {
		// The range must cover the Markdown source, not the rendered text: editing
		// shows `**b**` so the emphasis survives a round-trip.
		const { state, model } = modelFor('| a |\n|---|\n| **b** |\n');
		const cell = model.cellRanges[1][0]!;
		expect(state.sliceDoc(cell.from, cell.to)).toBe('**b**');
	});

	it('keeps an escaped pipe inside one cell', () => {
		const { state, model } = modelFor('| a | b |\n|---|---|\n| x \\| y | 2 |\n');
		const sliced = model.cellRanges[1].map((c) => (c ? state.sliceDoc(c.from, c.to) : null));
		expect(sliced).toEqual(['x \\| y', '2']);
	});
});

describe('sanitizeCellInput', () => {
	// A newline would split the row across two lines and a bare pipe would invent
	// a column, so either would break the table's structure on write-back.
	it('collapses newlines to spaces', () => {
		expect(sanitizeCellInput('a\nb')).toBe('a b');
		expect(sanitizeCellInput('a\r\nb')).toBe('a b');
	});

	it('escapes a bare pipe', () => {
		expect(sanitizeCellInput('a | b')).toBe('a \\| b');
	});

	it('leaves an already-escaped pipe alone', () => {
		expect(sanitizeCellInput('a \\| b')).toBe('a \\| b');
	});

	it('trims surrounding whitespace so the source keeps its own padding', () => {
		expect(sanitizeCellInput('  a  ')).toBe('a');
	});

	it('preserves inline markup verbatim', () => {
		expect(sanitizeCellInput('**b** and `c`')).toBe('**b** and `c`');
	});
});

describe('caretPastTable', () => {
	// The caret must land outside the table: anywhere on a table line makes
	// cursorTouchesLineRange true, which unrenders the table into raw pipe text.
	it('returns the start of the line after the table', () => {
		const doc = '| a | b |\n|---|---|\n| 1 | 2 |\nafter\n';
		const state = stateFor(doc);
		const caret = caretPastTable(state, 2, 0);
		expect(caret).not.toBeNull();
		expect(state.doc.lineAt(caret!).text).toBe('after');
	});

	it('shifts by the edit delta so it stays correct after the change applies', () => {
		const state = stateFor('| a | b |\n|---|---|\n| 1 | 2 |\nafter\n');
		// Growing a cell by 3 characters pushes every later position along by 3.
		expect(caretPastTable(state, 2, 3)).toBe(caretPastTable(state, 2, 0)! + 3);
	});

	it('returns null when the table runs to the end of the document', () => {
		const state = stateFor('| a | b |\n|---|---|\n| 1 | 2 |');
		expect(caretPastTable(state, 2, 0)).toBeNull();
	});
});
