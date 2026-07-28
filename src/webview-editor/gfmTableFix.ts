import { Table, TaskList, Strikethrough, Autolink, type BlockContext, type Line, type LeafBlock, type MarkdownExtension } from '@lezer/markdown';

const delimiterLine = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

function hasPipe(text: string, start: number): boolean {
	for (let i = start; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 0x7c) return true; // '|'
		if (ch === 0x5c) i++; // '\' escapes the next character
	}
	return false;
}

// Mirrors the cell-counting pass of @lezer/markdown's internal (unexported)
// `parseRow` — used only to compare column counts between a candidate header
// row and its delimiter row, never to build syntax nodes.
function countCells(text: string, start: number): number {
	let count = 0;
	let first = true;
	let cellStart = -1;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 0x7c /* '|' */ && !escaped) {
			if (!first || cellStart > -1) count++;
			first = false;
			cellStart = -1;
		} else if (escaped || (ch !== 0x20 && ch !== 0x09)) {
			if (cellStart < 0) cellStart = i;
		}
		escaped = !escaped && ch === 0x5c;
	}
	if (cellStart > -1) count++;
	return count;
}

// @lezer/markdown's built-in `Table` extension lets a table interrupt a
// paragraph (no blank line needed) — but only at the top level. Its `endLeaf`
// hook decides this by testing the *next* line against a delimiter-row regex
// via `cx.peekLine()`, which returns that line's raw text, indentation and
// all — while the regex (`^\|?...`) has no allowance for leading whitespace.
// Inside a list item every content line carries the item's indent (e.g. two
// spaces for "- "), so the match always fails there, and a table written
// directly under a list line (no blank line separating them) is silently
// absorbed as a lazy paragraph continuation instead of becoming a `Table`
// node — still reproduces against @lezer/markdown 1.7.2, the latest release
// as of this writing.
//
// A bare `LeafBlock` always carries a `SetextHeadingParser` — @lezer/markdown
// attaches one unconditionally to every leaf block (see `DefaultLeafBlocks`
// in its source), not just ones that could plausibly be a heading — so its
// presence alone says nothing about whether this leaf has already been
// claimed by something more specific (Table, Task, LinkReference, ...). Only
// the latter should make this hook stand down.
function hasClaimedParser(leaf: LeafBlock): boolean {
	return leaf.parsers.some((p) => p.constructor.name !== 'SetextHeadingParser');
}

// This extension adds a second `endLeaf` hook that repeats the same check
// with the next line's leading whitespace stripped first. Once it signals
// the interrupt, `Table`'s own `leaf` hook — which *does* correctly account
// for indentation — takes over on the fresh block, exactly as it would at
// the top level.
const fixIndentedTableInterrupt: MarkdownExtension = {
	parseBlock: [
		{
			name: 'FixIndentedTableInterrupt',
			endLeaf(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
				// Some other parser (Table's own included) already committed to
				// this leaf at its first line; let it keep handling every
				// subsequent line undisturbed.
				if (hasClaimedParser(leaf) || !hasPipe(line.text, line.basePos)) return false;
				const next = cx.peekLine();
				const trimmed = next.replace(/^[ \t]+/, '');
				if (trimmed.length === next.length) return false; // no indent — Table's own hook already covers this
				return delimiterLine.test(trimmed) && countCells(line.text, line.basePos) === countCells(trimmed, 0);
			},
		},
	],
};

export const GFM: MarkdownExtension[] = [fixIndentedTableInterrupt, Table, TaskList, Strikethrough, Autolink];
