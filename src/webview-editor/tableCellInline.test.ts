import { describe, it, expect, beforeAll } from 'vitest';
import { installStubDom, serializeChildren } from './testDom';
import { renderInlineInto } from './tableCellInline';

let createElement: (tag: string) => HTMLElement;

beforeAll(() => {
	({ createElement } = installStubDom());
});

const hooks = { resolveImageSrc: (src: string) => src };

/** Renders one cell's source and returns its inner HTML. */
function render(source: string): string {
	const cell = createElement('td');
	renderInlineInto(cell, source, hooks);
	return serializeChildren(cell);
}

describe('renderInlineInto', () => {
	it('leaves plain text alone', () => {
		expect(render('hello world')).toBe('hello world');
	});

	it('renders an empty cell as nothing', () => {
		expect(render('')).toBe('');
	});

	// Each expectation below matches what a reference GFM renderer (markdown-it,
	// the engine behind VS Code's built-in Markdown preview) produces for the
	// same cell source — the regex-based renderer this replaced got every one of
	// them wrong.
	describe('GFM parity', () => {
		it('renders bold and italic together', () => {
			expect(render('***bi***')).toBe('<em class="mlp-em"><strong class="mlp-strong">bi</strong></em>');
		});

		it('renders emphasis nested inside strong emphasis', () => {
			expect(render('**a *b* c**')).toBe('<strong class="mlp-strong">a <em class="mlp-em">b</em> c</strong>');
		});

		it('does not treat a spaced asterisk inside bold as emphasis', () => {
			expect(render('**2 * 3**')).toBe('<strong class="mlp-strong">2 * 3</strong>');
		});

		it('does not treat spaced asterisks as emphasis at all', () => {
			expect(render('a * b * c')).toBe('a * b * c');
		});

		it('recognizes underscore emphasis', () => {
			expect(render('_em_ and __strong__')).toBe(
				'<em class="mlp-em">em</em> and <strong class="mlp-strong">strong</strong>',
			);
		});

		it('renders an image, not a link with a stray "!"', () => {
			expect(render('![alt](img.png)')).toBe('<img src="img.png" alt="alt" class="mlp-image mlp-table-image">');
		});

		it('keeps the inner backtick of a multi-backtick code span', () => {
			expect(render('``a`b``')).toBe('<code class="mlp-inline-code">a`b</code>');
		});

		it('renders a link that carries a title', () => {
			expect(render('[t](http://x.com "ti")')).toBe(
				'<a title="ti" data-href="http://x.com" class="mlp-link">t</a>',
			);
		});

		it('renders a link nested inside strong emphasis', () => {
			expect(render('**[t](u)**')).toBe(
				'<strong class="mlp-strong"><a data-href="u" class="mlp-link">t</a></strong>',
			);
		});

		it('renders emphasis nested inside a link label', () => {
			expect(render('[**b** t](u)')).toBe(
				'<a data-href="u" class="mlp-link"><strong class="mlp-strong">b</strong> t</a>',
			);
		});

		it('honours backslash escapes instead of rendering emphasis', () => {
			expect(render('\\*not em\\*')).toBe('*not em*');
		});

		it('escapes bare angle brackets and ampersands rather than injecting markup', () => {
			expect(render('1 < 2 & 3')).toBe('1 &lt; 2 &amp; 3');
		});

		it('renders strikethrough', () => {
			expect(render('~~s~~')).toBe('<del class="mlp-strikethrough">s</del>');
		});

		it('renders inline code literally, without interpreting its markup', () => {
			expect(render('`**not bold**`')).toBe('<code class="mlp-inline-code">**not bold**</code>');
		});

		it('mixes code spans and emphasis in one cell', () => {
			expect(render('`a` and **b**')).toBe(
				'<code class="mlp-inline-code">a</code> and <strong class="mlp-strong">b</strong>',
			);
		});
	});

	describe('inline HTML', () => {
		it('honours <br> so a cell can hold a line break', () => {
			expect(render('x<br>y')).toBe('x<br>y');
		});

		it('honours a self-closing <br/>', () => {
			expect(render('x<br/>y')).toBe('x<br>y');
		});

		it('shows any other tag literally rather than injecting it into the webview', () => {
			// A cell must never be able to smuggle arbitrary markup into the DOM.
			expect(render('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
			expect(render('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
		});
	});

	describe('links', () => {
		it('marks a link with data-href so the editor\'s ctrl-click handler finds it', () => {
			const cell = createElement('td');
			renderInlineInto(cell, '[t](http://x.com)', hooks);
			expect(serializeChildren(cell)).toContain('data-href="http://x.com"');
		});

		it('promotes a bare URL to a link', () => {
			expect(render('https://x.com')).toBe('<a data-href="https://x.com" class="mlp-link">https://x.com</a>');
		});

		it('resolves a relative image path through the provided hook', () => {
			const cell = createElement('td');
			renderInlineInto(cell, '![a](p.png)', { resolveImageSrc: (src) => `base://${src}` });
			expect(serializeChildren(cell)).toBe('<img src="base://p.png" alt="a" class="mlp-image mlp-table-image">');
		});
	});
});
