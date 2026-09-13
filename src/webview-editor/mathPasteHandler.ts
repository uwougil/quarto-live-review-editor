import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isInsideFence, normalizeMathDelimiters } from '../quarto/normalizeMathDelimiters';

/**
 * Intercepts a text paste and rewrites ChatGPT-style LaTeX math delimiters
 * (`\(...\)` / `\[...\]`) into the Markdown delimiters this editor renders.
 *
 * The rewrite happens inside the paste handler's own dispatch, so pasting and
 * normalizing are one editing transaction: the host sees a single `edit`, and
 * one undo reverts the whole paste instead of needing two steps.
 *
 * Anything that does not need rewriting is handed back to CodeMirror's built-in
 * paste (`return false`) — including line-wise copies and the
 * one-line-per-selection form — so default paste behavior stays intact.
 */
export function createMathPasteHandler(isEnabled: () => boolean): Extension {
	return EditorView.domEventHandlers({
		paste(event, view) {
			if (!isEnabled()) return false;
			const raw = event.clipboardData?.getData('text/plain');
			// Cheap pre-filter: most pastes contain neither LaTeX delimiter, so they
			// never pay for the fence scan or the rewrite below.
			if (!raw || (!raw.includes('\\(') && !raw.includes('\\['))) return false;
			// Pasting into an existing code fence stays literal, the same way fenced
			// ranges inside the pasted fragment itself are left untouched.
			if (isInsideFence(view.state.doc.toString(), view.state.selection.main.from)) return false;

			const normalized = normalizeMathDelimiters(raw);
			if (normalized === raw) return false;

			event.preventDefault();
			// `changeByRange` keeps multi-cursor pastes correct: every selection
			// inserts the same normalized text in this one transaction.
			const spec = view.state.changeByRange((range) => ({
				changes: { from: range.from, to: range.to, insert: normalized },
				range: EditorSelection.cursor(range.from + normalized.length),
			}));
			view.dispatch({ ...spec, userEvent: 'input.paste', scrollIntoView: true });
			return true;
		},
	});
}
