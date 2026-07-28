import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { GFM } from './gfmTableFix';
import { alignedBlockRange } from './livePreviewPlugin';

/** Parses markdown text through the app's actual (patched) GFM config and
 * collects its top-level Table nodes in document order. */
function parse(doc: string): { state: EditorState; tables: SyntaxNode[] } {
	const state = EditorState.create({ doc, extensions: [markdown({ extensions: GFM })] });
	const tree = ensureSyntaxTree(state, state.doc.length, 5000);
	if (!tree) throw new Error('syntax tree did not finish parsing in time');
	const tables: SyntaxNode[] = [];
	tree.iterate({
		enter(node) {
			if (node.name === 'Table') tables.push(node.node);
		},
	});
	return { state, tables };
}

describe('gfmTableFix', () => {
	it('recognizes a table directly under a bullet list item with no blank line before it (regression)', () => {
		const { tables } = parse('- 重みづけ：\n  | 行動 | 経験値 |\n  |---|---|\n  | 配達1個 | 1pt |\n');
		expect(tables).toHaveLength(1);
	});

	it('recognizes a table directly under a numbered list item with no blank line before it', () => {
		const { tables } = parse('1. 重みづけ：\n   | a | b |\n   |---|---|\n   | c | d |\n');
		expect(tables).toHaveLength(1);
	});

	it('still recognizes a table interrupting an unindented paragraph (existing behavior unaffected)', () => {
		const { tables } = parse('text\n| a | b |\n|---|---|\n| c | d |\n');
		expect(tables).toHaveLength(1);
	});

	it('does not misfire when the list item itself starts with the table (already worked pre-fix)', () => {
		const { tables } = parse('- | a | b |\n  |---|---|\n  | c | d |\n');
		expect(tables).toHaveLength(1);
	});

	it('leaves a non-table (mismatched header/delimiter column count) as plain paragraph text', () => {
		const { tables } = parse('- text\n  | a | b |\n  |---|---|---|\n');
		expect(tables).toHaveLength(0);
	});

	// Domain generator (PBT-07): indentation widths a real list marker under a
	// "- " item (content column 2) could produce without crossing into either
	// "outside the list item" (< 2) or "indented code block" (>= 2 + 4) territory.
	it('widens an indented table\'s range to its own line start for block-decoration eligibility (PBT-03 invariant)', () => {
		fc.assert(
			fc.property(fc.integer({ min: 2, max: 5 }), (indent) => {
				const pad = ' '.repeat(indent);
				const doc = `- text\n${pad}| a | b |\n${pad}|---|---|\n${pad}| c | d |\n`;
				const { state, tables } = parse(doc);
				expect(tables).toHaveLength(1);
				const table = tables[0];
				const range = alignedBlockRange(state, table.from, table.to);
				expect(range).not.toBeNull();
				expect(range?.from).toBe(state.doc.lineAt(table.from).from);
			}),
		);
	});

	it('refuses to widen when non-whitespace shares the table\'s starting line (safety guard)', () => {
		const { state, tables } = parse('- | a | b |\n  |---|---|\n  | c | d |\n');
		const table = tables[0];
		// table.from sits right after "- " (the list marker), not after pure
		// indentation — widening back to the line start would swallow the
		// marker into the table's block decoration, so this must stay null.
		expect(alignedBlockRange(state, table.from, table.to)).toBeNull();
	});
});
