import { describe, it, expect, beforeAll } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { installStubDom, serialize } from './testDom';
import { GFM } from './gfmTableFix';
import { readTableModel, renderTableElement } from './livePreviewPlugin';

beforeAll(() => {
	installStubDom();
});

const hooks = { resolveImageSrc: (src: string) => src };

/** Renders the first table in `markdownText` and returns its HTML. */
function renderTable(markdownText: string): string {
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
	return serialize(renderTableElement(readTableModel(state, table), hooks));
}

/**
 * Strips the wrapper so a test can assert on rows alone.
 *
 * The `mlp-table-cell` class every cell carries is dropped too: it is a fixed
 * hook for the cell-editing CSS and click handling, identical on every cell, so
 * repeating it in each expectation would only obscure the content and alignment
 * these tests are actually about.
 */
function rowsOf(html: string): string {
	return html
		.replace(/^<table class="mlp-table">/, '')
		.replace(/<\/table>$/, '')
		.replace(/ class="mlp-table-cell"/g, '');
}

describe('renderTableElement', () => {
	it('renders a plain table as header and data rows', () => {
		expect(rowsOf(renderTable('| a | b |\n|---|---|\n| 1 | 2 |\n'))).toBe(
			'<tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr>',
		);
	});

	it('applies per-column alignment as inline text-align', () => {
		expect(rowsOf(renderTable('| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n'))).toBe(
			'<tr>' +
				'<th style="text-align:left">l</th>' +
				'<th style="text-align:center">c</th>' +
				'<th style="text-align:right">r</th>' +
				'</tr><tr>' +
				'<td style="text-align:left">1</td>' +
				'<td style="text-align:center">2</td>' +
				'<td style="text-align:right">3</td>' +
				'</tr>',
		);
	});

	it('pads a short row so the table is not ragged', () => {
		expect(rowsOf(renderTable('| a | b | c |\n|---|---|---|\n| 1 |\n'))).toBe(
			'<tr><th>a</th><th>b</th><th>c</th></tr><tr><td>1</td><td></td><td></td></tr>',
		);
	});

	it('renders inline markup inside cells', () => {
		expect(rowsOf(renderTable('| a |\n|---|\n| **b** and `c` |\n'))).toBe(
			'<tr><th>a</th></tr>' +
				'<tr><td><strong class="mlp-strong">b</strong> and <code class="mlp-inline-code">c</code></td></tr>',
		);
	});

	it('renders a table nested in a list item, markup and alignment intact', () => {
		// The nested case goes through the patched GFM parser (gfmTableFix.ts);
		// this checks the rendering path end-to-end for it too.
		expect(rowsOf(renderTable('- w:\n  | 行動 | 経験値 |\n  |---|---:|\n  | 配達 | **1pt** |\n'))).toBe(
			'<tr><th>行動</th><th style="text-align:right">経験値</th></tr>' +
				'<tr><td>配達</td><td style="text-align:right"><strong class="mlp-strong">1pt</strong></td></tr>',
		);
	});
});
