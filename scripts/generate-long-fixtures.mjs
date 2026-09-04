import { mkdir, writeFile } from 'node:fs/promises';

function buildLongDocument(lineCount) {
  const lines = Array.from({ length: lineCount });
  const put = (at, block) => {
    if (at < 0 || at + block.length > lineCount || block.some((_, i) => lines[at + i] !== undefined)) return;
    block.forEach((line, i) => { lines[at + i] = line; });
  };
  for (const [fraction, label] of [[0.25, '25'], [0.5, '50'], [0.75, '75'], [0.9, '90'], [0.99, '99']]) {
    const at = Math.min(lineCount - 1, Math.floor(lineCount * fraction));
    put(at - 1, ['', `# MARKER ${label}`, '']);
  }
  for (let at = 100; at + 3 < lineCount; at += 2000) put(at, ['```python', `value_${at} = ${at}`, '```', '']);
  for (let at = 500; at + 3 < lineCount; at += 2500) put(at, ['| k | E |', '|---|---|', `| ${at} | $E_${at}$ |`, '']);
  for (let at = 750; at + 3 < lineCount; at += 3000) put(at, [`- 列表项目 ${at}`, `- 列表项目 ${at + 1}`, '']);
  for (let at = 1500; at + 4 < lineCount; at += 5000) put(at, ['```mermaid', 'flowchart LR', `A${at}[数据] --> B${at}[结果]`, '```', '']);
  for (let i = 0; i < lineCount; i++) {
    lines[i] ??= `科研段落 ${i}：包含 **粗体**、*斜体*、[链接](https://example.com)、行内公式 $x_${i}$ 和普通文本。`;
  }
  return lines.join('\n');
}

await mkdir('examples/generated', { recursive: true });
await writeFile('examples/generated/long-document-10k.md', buildLongDocument(10_000));
await writeFile('examples/generated/long-document-20k.md', buildLongDocument(20_000));
console.log('Generated examples/generated/long-document-10k.md and long-document-20k.md');
