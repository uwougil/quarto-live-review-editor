export interface FrontmatterRange {
	from: number;
	to: number;
	yamlText: string;
	closingLine: number;
}

/** Canonical front matter scanner shared by fence and widget consumers. */
export function findFrontmatterRange(text: string): FrontmatterRange | null {
	const lines: Array<{ from: number; to: number; text: string }> = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf('\n', start);
		const rawTo = newline === -1 ? text.length : newline;
		const to = rawTo > start && text[rawTo - 1] === '\r' ? rawTo - 1 : rawTo;
		lines.push({ from: start, to, text: text.slice(start, to) });
		if (newline === -1) break;
		start = newline + 1;
	}
	if (lines.length < 2 || lines[0].text !== '---') return null;

	for (let index = 1; index < lines.length; index++) {
		if (!/^(?:---|\.\.\.)\s*$/.test(lines[index].text.trimStart())) continue;
		const yamlText = index > 1 ? text.slice(lines[1].from, lines[index - 1].to) : '';
		return { from: lines[0].from, to: lines[index].to, yamlText, closingLine: index };
	}
	return null;
}
