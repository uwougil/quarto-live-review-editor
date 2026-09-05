import type { EditorState } from '@codemirror/state';

/**
 * Tests whether any editor selection intersects one inline syntax node.
 *
 * Inline reveal decisions use document character offsets. A caret is inside a
 * node at either endpoint, while a non-empty selection intersects it when the
 * two half-open ranges overlap. Keeping this rule in one helper makes math and
 * Markdown inline widgets agree at their boundaries.
 */
export function selectionTouchesInlineRange(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((selection) =>
		selection.empty
			? selection.head >= from && selection.head <= to
			: selection.from <= to && selection.to >= from,
	);
}
