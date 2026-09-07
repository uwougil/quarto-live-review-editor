export interface HeadingItem {
	level: number;
	text: string;
	/** 1-based line number, matching CodeMirror's `doc.line(n)` convention. */
	line: number;
}

/**
 * Extracts ATX headings ("# " through "###### ") from Markdown text, in
 * document order. Line-based (not a full parse), matching the outline's
 * needs: a heading's line number is all the webview needs to jump to it via
 * `state.doc.line(n).from`.
 *
 * Headings inside fenced code blocks (``` or ~~~) are ignored — a line like
 * "# not a heading" inside a fence is source code, not a document heading.
 */
export function extractHeadings(text: string): HeadingItem[] {
	const lines = text.split(/\r\n|\r|\n/);
	const headings: HeadingItem[] = [];
	let fenceMarker: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();
		const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);

		if (fenceMarker) {
			// Only the same marker character, at least as long as the opener, closes it.
			if (fenceMatch && fenceMatch[1][0] === fenceMarker[0] && fenceMatch[1].length >= fenceMarker.length) {
				fenceMarker = null;
			}
			continue;
		}

		if (fenceMatch) {
			fenceMarker = fenceMatch[1];
			continue;
		}

		const headingMatch = /^(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(line);
		if (headingMatch && (headingMatch[2] !== undefined || /^#{1,6}$/.test(line))) {
			headings.push({ level: headingMatch[1].length, text: (headingMatch[2] ?? '').trim(), line: i + 1 });
		}
	}

	return headings;
}

function headingSlug(value: string): string {
	return value
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/[`*_~]/g, '')
		.toLocaleLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-');
}

/** Resolves generated heading IDs and explicit Pandoc/Quarto `{#id}` IDs. */
export function findMarkdownAnchorLine(text: string, fragment: string): number | undefined {
	const wanted = fragment.replace(/^#/, '');
	const lines = text.split(/\r\n|\r|\n/);
	const seen = new Map<string, number>();
	let fenceMarker: string | null = null;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const trimmed = line.trimStart();
		const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
		if (fenceMarker) {
			if (fenceMatch && fenceMatch[1][0] === fenceMarker[0] && fenceMatch[1].length >= fenceMarker.length) fenceMarker = null;
			continue;
		}
		if (fenceMatch) {
			fenceMarker = fenceMatch[1];
			continue;
		}

		const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (!match) continue;
		let headingText = match[2].trim();
		const attributes = /\s*\{([^}]*)\}\s*$/.exec(headingText);
		const explicit = attributes ? /(?:^|\s)#([^\s}]+)/.exec(attributes[1])?.[1] : undefined;
		if (attributes) headingText = headingText.slice(0, attributes.index).trim();
		const base = headingSlug(headingText);
		const duplicate = seen.get(base) ?? 0;
		seen.set(base, duplicate + 1);
		const generated = duplicate === 0 ? base : `${base}-${duplicate}`;
		if (explicit === wanted || generated === wanted) return index + 1;
	}
	return undefined;
}
