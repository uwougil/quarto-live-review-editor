import { findFenceSpans } from './fence';
import { findFrontmatterRange } from './frontmatter';
import { codeSpanMask, findMathRanges, isEscaped } from './math';

export interface NormalizedMathPaste {
	text: string;
	displayRanges: Array<{ from: number; to: number }>;
}

/**
 * Mask covering fenced code blocks.
 *
 * Deliberately does not reuse `math.ts`'s `ignoredMask`: that one also treats a
 * leading `---` line as front matter, which is the right rule for a whole
 * document but the wrong one for a pasted fragment of body text.
 */
function fenceMask(text: string): Uint8Array {
	const mask = new Uint8Array(text.length);
	for (const span of findFenceSpans(text)) mask.fill(1, span.from, span.to);
	return mask;
}

/** Mask covering existing `$...$` / `$$...$$` ranges, which must not be touched. */
function mathMask(text: string): Uint8Array {
	const mask = new Uint8Array(text.length);
	for (const range of findMathRanges(text)) mask.fill(1, range.from, range.to);
	return mask;
}

/** Mask covering front matter and fenced code in a complete destination document. */
function destinationIgnoredMask(text: string, fenced: Uint8Array): Uint8Array {
	const ignored = new Uint8Array(text.length);
	const frontmatter = findFrontmatterRange(text);
	if (frontmatter) {
		let to = frontmatter.to;
		if (text[to] === '\r' && text[to + 1] === '\n') to += 2;
		else if (text[to] === '\n' || text[to] === '\r') to++;
		ignored.fill(1, frontmatter.from, Math.min(to, text.length));
	}
	for (let i = 0; i < fenced.length; i++) if (fenced[i]) ignored[i] = 1;
	return ignored;
}

/**
 * Returns whether a caret or replacement range is inside a source-protected
 * destination context. A non-empty selection is rejected when it intersects
 * any protected range, so one multi-selection paste cannot normalize only some
 * of its targets.
 */
export function isProtectedPasteTarget(text: string, from: number, to = from): boolean {
	const start = Math.max(0, Math.min(from, text.length));
	const end = Math.max(start, Math.min(to, text.length));
	const fenced = fenceMask(text);
	const ignored = destinationIgnoredMask(text, fenced);
	const code = codeSpanMask(text, ignored);
	const math = mathMask(text);
	const protectedAt = (position: number): boolean => Boolean(ignored[position] || code[position] || math[position]);
	if (start === end) return protectedAt(start);
	for (let position = start; position < end; position++) {
		if (protectedAt(position)) return true;
	}
	return findMathRanges(text).some((range) => range.from < end && start < range.to);
}

/** True when `pos` falls inside a fenced code block (including an unclosed one). */
export function isInsideFence(text: string, pos: number): boolean {
	return findFenceSpans(text).some((span) => span.from <= pos && pos < span.to);
}

/**
 * Rewrites ChatGPT-style LaTeX delimiters into the Markdown math delimiters this
 * editor renders: `\(...\)` becomes `$...$` and `\[...\]` becomes a block
 * `$$` wrapped over its own lines.
 *
 * Only the delimiters are rewritten — interior spacing, line breaks and LaTeX
 * environments are copied verbatim, so `\( E \)` keeps its spaces and a
 * multi-line `\begin{aligned}` block keeps every line exactly as pasted.
 *
 * Ranges inside fenced code, inline code or existing `$` math are left alone.
 * An opener without a matching closer is passed through unchanged rather than
 * being closed at the end of the fragment: a half-pasted formula is better left
 * as source than turned into a stray `$` that swallows unrelated text.
 */
export function normalizeMathDelimitersWithMetadata(text: string): NormalizedMathPaste {
	if (!text.includes('\\(') && !text.includes('\\[')) return { text, displayRanges: [] };

	const fenced = fenceMask(text);
	const code = codeSpanMask(text, fenced);
	const math = mathMask(text);
	const protectedAt = (index: number): boolean => Boolean(fenced[index] || code[index] || math[index]);
	const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';

	// The last position is never an opener/closer start, so both scans stop early
	// and every `text[i + 1]` / `text[j + 1]` lookup is in range.
	const end = text.length - 1;
	let out = '';
	let copied = 0;
	const displayRanges: Array<{ from: number; to: number }> = [];
	for (let i = 0; i < end; i++) {
		if (protectedAt(i) || text[i] !== '\\' || isEscaped(text, i)) continue;
		const opener = text[i + 1];
		if (opener !== '(' && opener !== '[') continue;
		const closer = opener === '(' ? ')' : ']';

		let close = -1;
		for (let j = i + 2; j < end; j++) {
			if (protectedAt(j)) continue;
			if (text[j] === '\\' && text[j + 1] === closer && !isEscaped(text, j)) {
				close = j;
				break;
			}
		}
		if (close === -1) continue;

		const inner = text.slice(i + 2, close);
		out += text.slice(copied, i);
		const replacement = opener === '('
			? `$${inner}$`
			// A block formula always occupies its own lines, even when it was
			// pasted as `\[E\]`; only one line break is stripped on each side so
			// deliberate blank lines inside the formula survive.
			: `$$${lineBreak}${inner.replace(/^\r?\n/, '').replace(/\r?\n$/, '')}${lineBreak}$$`;
		const replacementFrom = out.length;
		out += replacement;
		if (opener === '[') displayRanges.push({ from: replacementFrom, to: out.length });
		copied = close + 2;
		// Continue past the closing delimiter so replacements never overlap.
		i = close + 1;
	}
	return { text: out + text.slice(copied), displayRanges };
}

export function normalizeMathDelimiters(text: string): string {
	return normalizeMathDelimitersWithMetadata(text).text;
}
