export interface SourceLine {
	from: number;
	to: number;
	fullTo: number;
	text: string;
}

export interface FenceAttributes {
	classes: string[];
	id?: string;
	keyValues: Record<string, string | true>;
	positional: string[];
}

export interface FenceInfo {
	rawInfo: string;
	language?: string;
	quartoCell: boolean;
	attributes?: FenceAttributes;
}

export interface FenceBlock {
	from: number;
	to: number;
	contentFrom: number;
	contentTo: number;
	openingLine: number;
	closingLine: number;
	marker: '`' | '~';
	markerLength: number;
	info: FenceInfo;
}

/** Splits source without losing whether each separator was LF or CRLF. */
export function scanSourceLines(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf('\n', start);
		const rawTo = newline === -1 ? text.length : newline;
		const to = rawTo > start && text[rawTo - 1] === '\r' ? rawTo - 1 : rawTo;
		lines.push({
			from: start,
			to,
			fullTo: newline === -1 ? text.length : newline + 1,
			text: text.slice(start, to),
		});
		if (newline === -1) break;
		start = newline + 1;
	}
	return lines;
}

function tokenizeInfo(value: string): string[] {
	return value.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s]+/g) ?? [];
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

function addAttribute(attributes: FenceAttributes, token: string): void {
	const value = unquote(token);
	if (value.startsWith('.')) {
		if (value.length > 1) attributes.classes.push(value.slice(1));
		return;
	}
	if (value.startsWith('#')) {
		if (value.length > 1) attributes.id = value.slice(1);
		return;
	}
	const equals = value.indexOf('=');
	if (equals > 0) {
		const key = value.slice(0, equals);
		attributes.keyValues[key] = unquote(value.slice(equals + 1)) || true;
		return;
	}
	attributes.positional.push(value);
}

function parseAttributes(tokens: string[]): FenceAttributes | undefined {
	if (tokens.length === 0) return undefined;
	const attributes: FenceAttributes = { classes: [], keyValues: {}, positional: [] };
	for (const token of tokens) addAttribute(attributes, token);
	return attributes;
}

/** Parses ordinary Markdown info and Quarto/Pandoc brace info uniformly. */
export function parseFenceInfo(rawInfo: string): FenceInfo {
	const trimmed = rawInfo.trim();
	if (!trimmed) return { rawInfo, quartoCell: false };

	const braceMatch = /^\{([\s\S]*)\}$/.exec(trimmed);
	if (braceMatch) {
		const tokens = tokenizeInfo(braceMatch[1]);
		let language: string | undefined;
		const rest: string[] = [];
		for (const token of tokens) {
			const clean = unquote(token);
			if (!language && clean.startsWith('.') && clean.length > 1) {
				language = clean.slice(1).toLowerCase();
				rest.push(token);
				continue;
			}
			if (!language && clean && !clean.startsWith('.') && !clean.startsWith('#') && !clean.includes('=')) {
				language = clean.toLowerCase();
				continue;
			}
			rest.push(token);
		}
		return { rawInfo, language, quartoCell: true, attributes: parseAttributes(rest) };
	}

	const tokens = tokenizeInfo(trimmed);
	const first = tokens.shift();
	let language: string | undefined;
	const attributes: string[] = [];
	if (first) {
		const clean = unquote(first);
		if (clean.startsWith('.')) language = clean.slice(1).toLowerCase() || undefined;
		else if (!clean.startsWith('#') && !clean.includes('=')) language = clean.toLowerCase();
		else attributes.push(first);
	}
	attributes.push(...tokens);
	return { rawInfo, language, quartoCell: false, attributes: parseAttributes(attributes) };
}

interface OpenFence {
	line: SourceLine;
	lineNumber: number;
	marker: '`' | '~';
	markerLength: number;
	info: FenceInfo;
}

function openingFence(line: SourceLine): { marker: '`' | '~'; markerLength: number; rawInfo: string } | undefined {
	const match = /^\s{0,3}(`{3,}|~{3,})([\s\S]*)$/.exec(line.text);
	if (!match) return undefined;
	return { marker: match[1][0] as '`' | '~', markerLength: match[1].length, rawInfo: match[2].trim() };
}

function closingFence(line: SourceLine, open: OpenFence): boolean {
	const match = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line.text);
	return Boolean(match && match[1][0] === open.marker && match[1].length >= open.markerLength);
}

function frontmatterEnd(lines: SourceLine[]): number | undefined {
	if (lines.length === 0 || lines[0].text.trim() !== '---') return undefined;
	for (let i = 1; i < lines.length; i++) {
		if (/^\s*(?:---|\.\.\.)\s*$/.test(lines[i].text)) return i;
	}
	return lines.length;
}

/** Finds closed fenced blocks, including Quarto `{language}` cells. */
export function findFenceBlocks(text: string): FenceBlock[] {
	const lines = scanSourceLines(text);
	const result: FenceBlock[] = [];
	const fmEnd = frontmatterEnd(lines);
	let open: OpenFence | undefined;
	for (let i = 0; i < lines.length; i++) {
		if (fmEnd !== undefined && i <= fmEnd) continue;
		const line = lines[i];
		if (!open) {
			const opening = openingFence(line);
			if (opening) open = { line, lineNumber: i, marker: opening.marker, markerLength: opening.markerLength, info: parseFenceInfo(opening.rawInfo) };
			continue;
		}
		if (!closingFence(line, open)) continue;
		const contentStartLine = open.lineNumber + 1;
		const contentEndLine = i - 1;
		result.push({
			from: open.line.from,
			to: line.to,
			contentFrom: contentStartLine <= contentEndLine ? lines[contentStartLine].from : line.from,
			contentTo: line.from,
			openingLine: open.lineNumber,
			closingLine: i,
			marker: open.marker,
			markerLength: open.markerLength,
			info: open.info,
		});
		open = undefined;
	}
	return result;
}

/** Returns fence spans that also include an unclosed fence through EOF. */
export function findFenceSpans(text: string): Array<{ from: number; to: number }> {
	const lines = scanSourceLines(text);
	const fmEnd = frontmatterEnd(lines);
	const spans: Array<{ from: number; to: number }> = [];
	let open: OpenFence | undefined;
	for (let i = 0; i < lines.length; i++) {
		if (fmEnd !== undefined && i <= fmEnd) continue;
		const line = lines[i];
		if (!open) {
			const opening = openingFence(line);
			if (opening) open = { line, lineNumber: i, marker: opening.marker, markerLength: opening.markerLength, info: parseFenceInfo(opening.rawInfo) };
			continue;
		}
		if (!closingFence(line, open)) continue;
		spans.push({ from: open.line.from, to: line.fullTo });
		open = undefined;
	}
	if (open) spans.push({ from: open.line.from, to: text.length });
	return spans;
}
