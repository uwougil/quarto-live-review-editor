import type { EditorState } from '@codemirror/state';

/**
 * Tests whether any editor selection enters one inline syntax node.
 *
 * Inline reveal decisions use document character offsets. A caret is inside a
 * source range is half-open, and a collapsed caret only enters its strict
 * interior. A caret on a shared boundary therefore touches neither adjacent
 * node, which prevents cursor motion and repeated clicks from revealing a
 * neighboring source token. Non-empty selections use ordinary half-open
 * overlap semantics.
 */
export function selectionTouchesInlineRange(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((selection) =>
		selection.empty
			? selection.head > from && selection.head < to
			: selection.from < to && selection.to > from,
	);
}
