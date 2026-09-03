import type { EditorState } from '@codemirror/state';

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

/** Finds Pandoc/Quarto math while ignoring front matter, fences, code spans and escaped dollars. */
export function findMathRanges(text: string): MathRange[] {
	const ranges: MathRange[] = [];
	const lines = text.split(/\r?\n/);
	let offset = 0;
	let inFrontmatter = /^---\r?\n/.test(text);
	let fence: '`' | '~' | null = null;
	let fenceLength = 0;

	for (const line of lines) {
		const lineEnd = offset + line.length;
		if (inFrontmatter) {
			if (offset > 0 && /^\s*---\s*$/.test(line)) inFrontmatter = false;
			offset = lineEnd + 1;
			continue;
		}
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0] as '`' | '~';
			if (!fence) {
				fence = marker;
				fenceLength = fenceMatch[1].length;
			} else if (marker === fence && fenceMatch[1].length >= fenceLength) {
				fence = null;
			}
			offset = lineEnd + 1;
			continue;
		}
		if (fence) {
			offset = lineEnd + 1;
			continue;
		}

		let inCodeSpan = false;
		for (let i = 0; i < line.length; i++) {
			if (line[i] === '`') {
				inCodeSpan = !inCodeSpan;
				continue;
			}
			if (inCodeSpan || line[i] !== '$' || line[i - 1] === '$' || line[i + 1] === '$' || isEscaped(line, i)) continue;
			let close = i + 1;
			while (close < line.length && (line[close] !== '$' || line[close - 1] === '$' || isEscaped(line, close) || line[close + 1] === '$')) close++;
			if (close < line.length && line[close] === '$') {
				const tex = line.slice(i + 1, close).trim();
				if (tex) ranges.push({ from: offset + i, to: offset + close + 1, display: false, tex });
				i = close;
			}
		}
		offset = lineEnd + 1;
	}

	return ranges.concat(findDisplayRanges(text, ranges)).sort((a, b) => a.from - b.from);
}

function findDisplayRanges(text: string, existing: MathRange[]): MathRange[] {
	const output: MathRange[] = [];
	const lines = text.split(/\r?\n/);
	let offset = 0;
	let inFrontmatter = /^---\r?\n/.test(text);
	let fence: '`' | '~' | null = null;
	let open: number | null = null;
	for (const line of lines) {
		if (inFrontmatter) {
			if (offset > 0 && /^\s*---\s*$/.test(line)) inFrontmatter = false;
			offset += line.length + 1;
			continue;
		}
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0] as '`' | '~';
			fence = fence === marker ? null : fence ?? marker;
			offset += line.length + 1;
			continue;
		}
		if (!fence) {
			let inCodeSpan = false;
			for (let i = 0; i < line.length - 1; i++) {
				if (line[i] === '`') {
					inCodeSpan = !inCodeSpan;
					i++;
					continue;
				}
				if (inCodeSpan || line[i] !== '$' || line[i + 1] !== '$' || isEscaped(line, i)) continue;
				const position = offset + i;
				if (existing.some((range) => position >= range.from && position < range.to)) {
					i++;
					continue;
				}
				if (open === null) open = position;
				else {
					const tex = text.slice(open + 2, position).trim();
					if (tex) output.push({ from: open, to: position + 2, display: true, tex });
					open = null;
				}
				i++;
			}
		}
		offset += line.length + 1;
	}
	return output;
}

export function mathRangeTouchesSelection(state: EditorState, range: MathRange): boolean {
	return state.selection.ranges.some((selection) =>
		selection.empty
			? selection.head >= range.from && selection.head <= range.to
			: selection.from <= range.to && selection.to >= range.from,
	);
}
