import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
	isProtectedPasteTarget,
	normalizeMathDelimitersWithMetadata,
	type NormalizedMathPaste,
} from '../quarto/normalizeMathDelimiters';

function isLineBreakCharacter(value: string | undefined): boolean {
	return value === '\n' || value === '\r';
}

function convertLineEndings(text: string, lineBreak: string): string {
	return text.replace(/\r\n?|\n/g, lineBreak);
}

function mapOffsetWithLineEndings(text: string, offset: number, lineBreak: string): number {
	return convertLineEndings(text.slice(0, offset), lineBreak).length;
}

/**
 * Adds only the line breaks required to make generated display delimiters
 * standalone in the destination document. The clipboard normalizer remains a
 * fragment-only transformation; this function is the destination-context
 * adjustment owned by the paste/edit layer.
 */
export function formatNormalizedMathPaste(
	documentText: string,
	from: number,
	to: number,
	normalized: NormalizedMathPaste,
): string {
	if (normalized.displayRanges.length === 0) return normalized.text;

	const lineBreak = documentText.includes('\r\n') ? '\r\n' : '\n';
	let text = convertLineEndings(normalized.text, lineBreak);
	const displayRanges = normalized.displayRanges.map((range) => ({
		from: mapOffsetWithLineEndings(normalized.text, range.from, lineBreak),
		to: mapOffsetWithLineEndings(normalized.text, range.to, lineBreak),
	}));
	const boundaries = displayRanges.flatMap((range) => [
		{ position: range.from, direction: 'before' as const },
		{ position: range.to, direction: 'after' as const },
	]);
	boundaries.sort((a, b) => b.position - a.position);

	for (const boundary of boundaries) {
		if (boundary.direction === 'before') {
			const previous = boundary.position > 0 ? text[boundary.position - 1] : documentText[from - 1];
			if (previous !== undefined && !isLineBreakCharacter(previous)) {
				text = text.slice(0, boundary.position) + lineBreak + text.slice(boundary.position);
			}
			continue;
		}

		const next = boundary.position < text.length ? text[boundary.position] : documentText[to];
		if (next !== undefined && !isLineBreakCharacter(next)) {
			text = text.slice(0, boundary.position) + lineBreak + text.slice(boundary.position);
		}
	}
	return text;
}

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
			const documentText = view.state.doc.toString();
			// A single unsafe target makes the whole paste use CodeMirror's default
			// behavior; never normalize only a subset of a multi-selection paste.
			if (view.state.selection.ranges.some((range) => isProtectedPasteTarget(documentText, range.from, range.to))) return false;

			const normalized = normalizeMathDelimitersWithMetadata(raw);
			if (normalized.text === raw) return false;

			event.preventDefault();
			// `changeByRange` keeps multi-cursor pastes correct: every selection is
			// formatted against its original destination context in one transaction.
			const spec = view.state.changeByRange((range) => {
				const insert = formatNormalizedMathPaste(documentText, range.from, range.to, normalized);
				return {
					changes: { from: range.from, to: range.to, insert },
					range: EditorSelection.cursor(range.from + insert.length),
				};
			});
			view.dispatch({ ...spec, userEvent: 'input.paste', scrollIntoView: true });
			return true;
		},
	});
}
