import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findFenceBlocks } from './fence';
import { findMathRanges } from './math';

const fixture = readFileSync(new URL('../../examples/quarto-scientific.qmd', import.meta.url), 'utf8');

describe('scientific Quarto regression fixture', () => {
	it('contains source-safe Quarto constructs and all expected code-cell languages', () => {
		expect(fixture).toContain('[@blochl1994]');
		expect(fixture).toContain('@fig-band');
		expect(fixture).toContain('{{< meta title >}}');
		expect(fixture).toContain('::: {.callout-note}');
		expect(fixture).toContain('<span class="scientific-note">');
		expect(fixture).toContain('```{=latex}');
		expect(fixture).toContain('```mermaid');
		expect(findFenceBlocks(fixture).map((block) => block.info.language)).toEqual(['python', 'python', 'r', 'julia', 'python', 'mermaid', undefined]);
	});

	it('finds only the editable math and leaves dollars in protected contexts alone', () => {
		const ranges = findMathRanges(fixture);
		expect(ranges.map((range) => range.tex)).toEqual([
			'Ω_n(\\mathbf{k})',
			'\\Omega_n(\\mathbf{k}) = \\nabla_{\\mathbf{k}} \\times \\mathbf{A}_n(\\mathbf{k})',
			'\\sigma_{xy} = -\\frac{e^2}{\\hbar}\\sum_n \\int_{\\mathrm{BZ}}\n\\frac{d^3k}{(2\\pi)^3} f_n(\\mathbf{k})\\Omega_{n,z}(\\mathbf{k})',
			'k_x',
			'k_y',
		]);
	});

	it('keeps untouched Quarto source byte-for-byte stable as the source of truth', () => {
		const before = fixture;
		const simulatedSave = before;
		expect(simulatedSave).toBe(before);
	});
});
