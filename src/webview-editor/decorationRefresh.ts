import { syntaxTree } from '@codemirror/language';
import { StateEffect, type EditorState, type Range, type Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import { detectFrontmatter } from './frontmatterWidget';

/** Rebuild direct line/block decorations after syntax becomes available for a new viewport. */
export interface DecorationRange {
	from: number;
	to: number;
}

export const refreshSyntaxDecorations = StateEffect.define<DecorationRange[]>();

export function initialDecorationRanges(state: EditorState): DecorationRange[] {
	return [{ from: 0, to: Math.min(state.doc.length, 20_000) }];
}

export function selectionDecorationRanges(...states: EditorState[]): DecorationRange[] {
	const ranges: DecorationRange[] = [];
	for (const state of states) {
		for (const selection of state.selection.ranges) {
			const fromLine = state.doc.lineAt(selection.from);
			const toLine = state.doc.lineAt(selection.to);
			// A Markdown paragraph owns its trailing blank separator line so theme
			// paragraph spacing can be distributed onto that measured CodeMirror
			// line. Rebuilding only the blank line after a click would first remove
			// the old paragraph decoration and then fail to rediscover the paragraph
			// node (which ends on the previous line), visibly collapsing the gap.
			// Include one line of left context only for a blank selection boundary;
			// this keeps ordinary cursor invalidation local while letting the
			// paragraph re-apply the separator-line class.
			const contextualFrom = fromLine.text === '' && fromLine.number > 1
				? state.doc.line(fromLine.number - 1).from
				: fromLine.from;
			ranges.push({ from: contextualFrom, to: toLine.to });
		}
	}
	return ranges;
}

function structuralRange(state: EditorState, from: number, to: number): DecorationRange {
	const safeFrom = Math.max(0, Math.min(from, state.doc.length));
	const safeTo = Math.max(safeFrom, Math.min(to, state.doc.length));
	const changedFrom = state.doc.lineAt(safeFrom).from;
	const changedTo = state.doc.lineAt(safeTo).to;
	const tree = syntaxTree(state);
	let structuralFrom = changedFrom;
	const includeTrailingBlankLine = (to: number): number => {
		const line = state.doc.lineAt(to);
		if (line.number >= state.doc.lines) return to;
		const next = state.doc.line(line.number + 1);
		return next.text === '' ? next.to : to;
	};
	let structuralTo = includeTrailingBlankLine(changedTo);

	// Markdown constructs that can change meaning together (lists, blockquotes,
	// tables and fences) are represented by top-level syntax nodes. Widening to
	// every top-level node touched by the changed lines captures the whole old or
	// new construct without turning a local edit into a document-wide rebuild.
	tree.iterate({
		from: changedFrom,
		to: changedTo,
		enter(node) {
			// SyntaxNodeRef.parent is a freshly wrapped node; a direct child of
			// the tree root is identified by having no grandparent.
			const parent = node.node.parent;
			if (!parent || parent.parent) return;
			structuralFrom = Math.min(structuralFrom, state.doc.lineAt(node.from).from);
			structuralTo = Math.max(structuralTo, includeTrailingBlankLine(state.doc.lineAt(node.to).to));
			return false;
		},
	});

	return { from: structuralFrom, to: structuralTo };
}

function mergeDecorationRanges(ranges: readonly DecorationRange[]): DecorationRange[] {
	const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
	const merged: DecorationRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (!previous || range.from > previous.to + 1) merged.push({ ...range });
		else previous.to = Math.max(previous.to, range.to);
	}
	return merged;
}

/** Local new-document ranges whose syntax-dependent decorations an edit can invalidate. */
export function changedDecorationRanges(transaction: Transaction): DecorationRange[] {
	if (!transaction.docChanged) return [];
	const ranges: DecorationRange[] = [];
	const oldFrontmatter = detectFrontmatter(transaction.startState);
	const newFrontmatter = detectFrontmatter(transaction.state);
	transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
		const oldRange = structuralRange(transaction.startState, fromA, toA);
		ranges.push({
			from: transaction.changes.mapPos(oldRange.from, -1),
			to: transaction.changes.mapPos(oldRange.to, 1),
		});
		ranges.push(structuralRange(transaction.state, fromB, toB));
		// Front matter is deliberately detected outside Lezer, so it has no
		// syntax node for structuralRange() to widen to. Include the complete
		// old/new front-matter block when an edit touches either range; otherwise
		// its block widget could survive a YAML or delimiter edit with stale data.
		if (oldFrontmatter && toA >= oldFrontmatter.from && fromA <= oldFrontmatter.to) {
			ranges.push({
				from: transaction.changes.mapPos(oldFrontmatter.from, -1),
				to: transaction.changes.mapPos(oldFrontmatter.to, 1),
			});
		}
		if (newFrontmatter && toB >= newFrontmatter.from && fromB <= newFrontmatter.to) ranges.push(newFrontmatter);
	});
	return mergeDecorationRanges(ranges);
}

export function replaceDecorationRanges(
	value: DecorationSet,
	replacement: DecorationSet,
	ranges: readonly DecorationRange[],
): DecorationSet {
	const add: Range<Decoration>[] = [];
	for (let iter = replacement.iter(); iter.value; iter.next()) add.push(iter.value.range(iter.from, iter.to));
	return value.update({
		filter: (from, to) => !ranges.some((range) => to >= range.from && from <= range.to),
		add,
		sort: true,
	});
}

export function decorationsWithin(value: DecorationSet, ranges: readonly DecorationRange[]): DecorationSet {
	const selected: Range<Decoration>[] = [];
	for (let iter = value.iter(); iter.value; iter.next()) {
		if (ranges.some((range) => iter.to >= range.from && iter.from <= range.to)) selected.push(iter.value.range(iter.from, iter.to));
	}
	return Decoration.set(selected, true);
}