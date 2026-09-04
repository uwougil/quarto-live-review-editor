import { describe, expect, it } from 'vitest';
import { findFenceBlocks, parseFenceInfo } from './fence';

describe('parseFenceInfo', () => {
	it('parses ordinary Markdown info and Pandoc attributes through one API', () => {
		expect(parseFenceInfo('python')).toMatchObject({ language: 'python', quartoCell: false });
		expect(parseFenceInfo('{python}')).toMatchObject({ language: 'python', quartoCell: true });
		expect(parseFenceInfo('{.python #fig-band echo=false}')).toMatchObject({
			language: 'python',
			quartoCell: true,
			attributes: { classes: ['python'], id: 'fig-band', keyValues: { echo: 'false' } },
		});
		expect(parseFenceInfo('{r label="fig-a"}')).toMatchObject({
			language: 'r',
			quartoCell: true,
			attributes: { keyValues: { label: 'fig-a' } },
		});
	});
});

describe('findFenceBlocks', () => {
	it('finds ordinary and Quarto code cells without losing CRLF offsets', () => {
		const text = [
			'---',
			'title: "A fence-looking value ```{python}"',
			'---',
			'```python',
			'print("ordinary")',
			'```',
			'```{python}',
			'#| label: fig-band',
			'print("cell")',
			'```',
			'```{r}',
			'plot(x)',
			'```',
		].join('\r\n');
		const blocks = findFenceBlocks(text);
		expect(blocks.map((block) => ({ language: block.info.language, quartoCell: block.info.quartoCell }))).toEqual([
			{ language: 'python', quartoCell: false },
			{ language: 'python', quartoCell: true },
			{ language: 'r', quartoCell: true },
		]);
		for (const block of blocks) {
			expect(text.slice(block.from, block.to)).toContain('```');
			expect(text.slice(block.contentFrom, block.contentTo)).not.toContain('```');
		}
		expect(text.slice(blocks[1].contentFrom, blocks[1].contentTo)).toContain('#| label: fig-band');
	});

	it('recognises .python as a future-compatible language attribute', () => {
		const [block] = findFenceBlocks('```{.python}\nprint(1)\n```');
		expect(block.info).toMatchObject({ language: 'python', quartoCell: true, attributes: { classes: ['python'] } });
	});
});
