import { StateEffect, type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';

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
			ranges.push({ from: fromLine.from, to: toLine.to });
		}
	}
	return ranges;
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
