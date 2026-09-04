import { StateField, type EditorState } from '@codemirror/state';
import { getDocumentDialect, type DocumentDialect } from './dialect';
import { findFenceSpans, scanSourceLines } from './fence';

export interface MathRange {
	from: number;
	to: number;
	display: boolean;
	tex: string;
}

function isEscaped(text: string, position: number): boolean {
	let backslashes = 0;
	for (let i = position - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
	return backslashes % 2 === 1;
}

function ignoredMask(text: string): Uint8Array {
	const ignored = new Uint8Array(text.length);
	const lines = scanSourceLines(text);
	if (lines.length > 0 && lines[0].text.trim() === '---') {
		let end = lines.length;
		for (let i = 1; i < lines.length; i++) {
			if (/^\s*(?:---|\.\.\.)\s*$/.test(lines[i].text)) {
				end = i + 1;
				break;
			}
		}
		const to = end < lines.length ? lines[end - 1].fullTo : text.length;
		ignored.fill(1, 0, to);
	}
	for (const span of findFenceSpans(text)) ignored.fill(1, span.from, span.to);
	return ignored;
}

function codeSpanMask(text: string, ignored: Uint8Array): Uint8Array {
	const code = new Uint8Array(text.length);
	for (const line of scanSourceLines(text)) {
		let i = line.from;
		while (i < line.to) {
			if (ignored[i] || text[i] !== '`') {
				i++;
				continue;
			}
			let run = 1;
			while (i + run < line.to && text[i + run] === '`') run++;
			let close = i + run;
			while (close < line.to) {
				if (!ignored[close] && text[close] === '`') {
					let closeRun = 1;
					while (close + closeRun < line.to && text[close + closeRun] === '`') closeRun++;
					if (closeRun === run) {
						code.fill(1, i, close + run);
						i = close + run;
						break;
					}
					close += closeRun;
					continue;
				}
				close++;
			}
			if (close >= line.to) {
				code.fill(1, i, line.to);
				i = line.to;
			}
		}
	}
	return code;
}

function validInlineOpening(text: string, position: number): boolean {
	const next = text[position + 1];
	return next !== undefined && next !== '$' && !/\s/.test(next);
}

function validInlineClosing(text: string, position: number): boolean {
	const previous = text[position - 1];
	return previous !== undefined && previous !== '$' && !/\s/.test(previous);
}

/** Finds math ranges with offsets taken directly from the original string. */
export function findMathRanges(text: string, _dialect: DocumentDialect = 'markdown'): MathRange[] {
	const ignored = ignoredMask(text);
	const code = codeSpanMask(text, ignored);
	const ranges: MathRange[] = [];

	for (let i = 0; i < text.length; i++) {
		if (ignored[i] || code[i] || text[i] !== '$' || isEscaped(text, i)) continue;

		if (text[i + 1] === '$' && !isEscaped(text, i + 1)) {
			let close = i + 2;
			while (close < text.length) {
				if (!ignored[close] && !code[close] && text[close] === '$' && text[close + 1] === '$' && !isEscaped(text, close)) break;
				close++;
			}
			if (close < text.length) {
				const tex = text.slice(i + 2, close).trim();
				if (tex) {
					ranges.push({ from: i, to: close + 2, display: true, tex });
					i = close + 1;
					continue;
				}
			}
		}

		if (text[i + 1] === '$' || text[i - 1] === '$' || !validInlineOpening(text, i)) continue;
		const newline = text.indexOf('\n', i + 1);
		const lineEnd = newline === -1 ? text.length : newline;
		let close = i + 1;
		while (close < lineEnd) {
			if (!ignored[close] && !code[close] && text[close] === '$' && !isEscaped(text, close) && text[close + 1] !== '$' && validInlineClosing(text, close)) break;
			close++;
		}
		if (close < lineEnd) {
			const tex = text.slice(i + 1, close).trim();
			if (tex) {
				ranges.push({ from: i, to: close + 1, display: false, tex });
				i = close;
			}
		}
	}
	return ranges.sort((a, b) => a.from - b.from);
}

export function mathRangeTouchesSelection(state: EditorState, range: MathRange): boolean {
	return state.selection.ranges.some((selection) =>
		selection.empty
			? selection.head >= range.from && selection.head <= range.to
			: selection.from <= range.to && selection.to >= range.from,
	);
}

/** Full math parsing happens once at creation and only after document edits. */
export const mathRangesField = StateField.define<MathRange[]>({
	create(state) {
		return findMathRanges(state.doc.toString(), getDocumentDialect(state));
	},
	update(value, transaction) {
		return transaction.docChanged ? findMathRanges(transaction.state.doc.toString(), getDocumentDialect(transaction.state)) : value;
	},
});

// Keep dialect consumption explicit at the syntax boundary, even though the
// first Quarto/Markdown math rules intentionally share the same implementation.
export function mathRangesForState(state: EditorState): MathRange[] {
	return state.field(mathRangesField);
}
