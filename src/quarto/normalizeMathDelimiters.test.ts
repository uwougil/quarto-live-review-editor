import { describe, expect, it } from 'vitest';
import { isInsideFence, normalizeMathDelimiters } from './normalizeMathDelimiters';

describe('normalizeMathDelimiters — inline math', () => {
	it('converts \\(...\\) to $...$', () => {
		expect(normalizeMathDelimiters('\\(E = mc^2\\)')).toBe('$E = mc^2$');
	});

	it('keeps the original spacing inside the delimiters', () => {
		expect(normalizeMathDelimiters('\\( E = mc^2 \\)')).toBe('$ E = mc^2 $');
	});

	it('converts every occurrence in a fragment', () => {
		expect(normalizeMathDelimiters('a \\(x\\) b \\(y\\) c')).toBe('a $x$ b $y$ c');
	});

	it('replaces only the delimiters when the body has odd line breaks', () => {
		expect(normalizeMathDelimiters('\\(\nE =\nmc^2\n\\)')).toBe('$\nE =\nmc^2\n$');
	});
});

describe('normalizeMathDelimiters — display math', () => {
	it('turns a single-line \\[...\\] into a block over its own lines', () => {
		expect(normalizeMathDelimiters('\\[E = mc^2\\]')).toBe('$$\nE = mc^2\n$$');
	});

	it('produces the same block form when the source already spans lines', () => {
		expect(normalizeMathDelimiters('\\[\nE = mc^2\n\\]')).toBe('$$\nE = mc^2\n$$');
	});

	it('keeps multi-line LaTeX environments intact', () => {
		const source = ['\\[', '\\begin{aligned}', 'E &= mc^2 \\\\', 'p &= mv', '\\end{aligned}', '\\]'].join('\n');
		const expected = ['$$', '\\begin{aligned}', 'E &= mc^2 \\\\', 'p &= mv', '\\end{aligned}', '$$'].join('\n');
		expect(normalizeMathDelimiters(source)).toBe(expected);
	});

	it('keeps deliberate blank lines inside the formula', () => {
		expect(normalizeMathDelimiters('\\[\n\nE\n\n\\]')).toBe('$$\n\nE\n\n$$');
	});

	it('follows the fragment line-ending style', () => {
		expect(normalizeMathDelimiters('a\r\n\\[E\\]\r\nb')).toBe('a\r\n$$\r\nE\r\n$$\r\nb');
	});
});

describe('normalizeMathDelimiters — untouched input', () => {
	it('leaves existing Markdown math alone', () => {
		expect(normalizeMathDelimiters('$x$')).toBe('$x$');
		expect(normalizeMathDelimiters('$$\nx^2\n$$')).toBe('$$\nx^2\n$$');
		expect(normalizeMathDelimiters('Prose $a \\ne b$ and $$c$$ end')).toBe('Prose $a \\ne b$ and $$c$$ end');
	});

	it('leaves LaTeX delimiters nested in existing $...$ alone', () => {
		expect(normalizeMathDelimiters('$a \\(b\\) c$')).toBe('$a \\(b\\) c$');
	});

	it('leaves fenced code blocks alone', () => {
		const source = ['```python', 'text = r"\\(x\\)"', '```'].join('\n');
		expect(normalizeMathDelimiters(source)).toBe(source);
	});

	it('leaves an unclosed fence (to EOF) alone', () => {
		const source = ['```', 'value = "\\(x\\)"'].join('\n');
		expect(normalizeMathDelimiters(source)).toBe(source);
	});

	it('leaves inline code alone', () => {
		expect(normalizeMathDelimiters('Use `\\(x\\)` as the input string.')).toBe('Use `\\(x\\)` as the input string.');
	});

	it('leaves escaped delimiters alone', () => {
		expect(normalizeMathDelimiters('a \\\\(x\\\\) b')).toBe('a \\\\(x\\\\) b');
	});

	it('leaves an unmatched opener as pasted', () => {
		expect(normalizeMathDelimiters('\\(x')).toBe('\\(x');
		expect(normalizeMathDelimiters('\\[x')).toBe('\\[x');
		expect(normalizeMathDelimiters('\\(a\\) and \\[b')).toBe('$a$ and \\[b');
	});

	it('returns text without LaTeX delimiters unchanged', () => {
		const source = 'plain text with $ no math';
		expect(normalizeMathDelimiters(source)).toBe(source);
	});
});

describe('normalizeMathDelimiters — mixed content and idempotence', () => {
	it('rewrites math while copying surrounding prose verbatim', () => {
		expect(normalizeMathDelimiters('Text \\(a\\) and \\[b\\] end')).toBe('Text $a$ and $$\nb\n$$ end');
	});

	it('is idempotent', () => {
		const source = 'a \\(x\\) b\n\\[\ny\n\\]\nc `\\(z\\)`';
		const once = normalizeMathDelimiters(source);
		expect(normalizeMathDelimiters(once)).toBe(once);
	});
});

describe('isInsideFence', () => {
	it('recognises positions inside a closed fence, and not outside it', () => {
		const text = ['before', '```', 'code', '```', 'after'].join('\n');
		expect(isInsideFence(text, 0)).toBe(false);
		expect(isInsideFence(text, text.indexOf('code'))).toBe(true);
		expect(isInsideFence(text, text.length - 1)).toBe(false);
	});

	it('treats an unclosed fence as extending to the end of the fragment', () => {
		const text = '```\ncode';
		expect(isInsideFence(text, text.indexOf('code'))).toBe(true);
		expect(isInsideFence(text, text.length - 1)).toBe(true);
	});
});
