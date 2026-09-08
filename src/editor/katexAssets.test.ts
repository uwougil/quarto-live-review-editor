import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const cssPath = path.join(repoRoot, 'media', 'katex.min.css');

describe('bundled KaTeX assets', () => {
	it('keeps every local font URL in the stylesheet inside the extension package', () => {
		const css = readFileSync(cssPath, 'utf8');
		const urls = [...css.matchAll(/url\((?:["']?)([^"')]+)(?:["']?)\)/g)].map((match) => match[1]);
		expect(urls).toHaveLength(60);
		expect(urls.every((url) => !/^(?:https?:|\/\/|data:)/i.test(url))).toBe(true);
		for (const url of urls) {
			const assetPath = path.resolve(path.dirname(cssPath), url);
			expect(assetPath.startsWith(path.join(repoRoot, 'media') + path.sep), url).toBe(true);
			expect(statSync(assetPath).size, url).toBeGreaterThan(0);
		}
	});

	it('bundles every KaTeX family needed for standard and extended TeX glyphs', () => {
		const css = readFileSync(cssPath, 'utf8');
		for (const family of [
			'KaTeX_AMS',
			'KaTeX_Caligraphic',
			'KaTeX_Fraktur',
			'KaTeX_Main',
			'KaTeX_Math',
			'KaTeX_SansSerif',
			'KaTeX_Script',
			'KaTeX_Size1',
			'KaTeX_Size2',
			'KaTeX_Size3',
			'KaTeX_Size4',
			'KaTeX_Typewriter',
		]) expect(css).toContain(`font-family:${family}`);
	});
});
