/** Builds a deterministic long document without committing a giant generated file. */
export function buildLongDocument(lineCount: number): string {
	if (!Number.isInteger(lineCount) || lineCount < 1) throw new RangeError('lineCount must be a positive integer');
	const lines: Array<string | undefined> = Array.from({ length: lineCount });
	const put = (at: number, block: string[]): void => {
		if (at < 0 || at + block.length > lineCount || block.some((_, i) => lines[at + i] !== undefined)) return;
		block.forEach((line, i) => { lines[at + i] = line; });
	};
	for (const [fraction, label] of [[0.25, '25'], [0.5, '50'], [0.75, '75'], [0.9, '90'], [0.99, '99']] as const) {
		const at = Math.min(lineCount - 1, Math.floor(lineCount * fraction));
		put(at - 1, ['', `# MARKER ${label}`, '']);
	}
	for (let at = 100; at + 3 < lineCount; at += 2000) {
		put(at, ['```python', `value_${at} = ${at}`, '```', '']);
	}
	for (let at = 500; at + 3 < lineCount; at += 2500) {
		put(at, ['| k | E |', '|---|---|', `| ${at} | $E_${at}$ |`, '']);
	}
	for (let at = 750; at + 3 < lineCount; at += 3000) {
		put(at, [`- 列表项目 ${at}`, `- 列表项目 ${at + 1}`, '']);
	}
	for (let at = 1500; at + 4 < lineCount; at += 5000) {
		put(at, ['```mermaid', 'flowchart LR', `A${at}[数据] --> B${at}[结果]`, '```', '']);
	}
	for (let i = 0; i < lineCount; i++) {
		lines[i] ??= `科研段落 ${i}：包含 **粗体**、*斜体*、[链接](https://example.com)、行内公式 $x_${i}$ 和普通文本。`;
	}
	return lines.join('\n');
}
