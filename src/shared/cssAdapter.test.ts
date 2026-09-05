import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { adaptMarkdownCss } from './cssAdapter';

// Tags the adapter deliberately leaves untouched (rendered with their real tag
// in the live preview, so no selector mapping applies to them).
const UNTOUCHED_TAGS = ['a', 'strong', 'em', 'del', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div'];

// Block-level tags mapped to a fixed replacement class, paired with the class
// each one is expected to contain in the output (PBT-07: domain-specific
// generator reflecting the adapter's own known mapping table, not raw strings).
const MAPPED_BLOCK_TAGS: Array<[string, string]> = [
	['h1', '.cm-line.mlp-line-h1'],
	['h2', '.cm-line.mlp-line-h2'],
	['h3', '.cm-line.mlp-line-h3'],
	['h4', '.cm-line.mlp-line-h4'],
	['h5', '.cm-line.mlp-line-h5'],
	['h6', '.cm-line.mlp-line-h6'],
	['blockquote', '.cm-line.mlp-line-quote'],
	['hr', '.mlp-hr'],
	['code', '.mlp-inline-code'],
];

// Realistic CSS property/value pairs (not arbitrary strings) so generated
// declarations stay parseable and don't accidentally exercise the box-model
// distribution logic (padding/margin/border), which is out of scope here.
const safeProp = fc.constantFrom('color', 'font-size', 'font-weight', 'line-height', 'background-color', 'opacity');
const safeValue = fc.constantFrom('red', '#333', '1rem', '14px', 'bold', '1.5', '0.8', 'inherit');
const declaration = fc.tuple(safeProp, safeValue).map(([p, v]) => `${p}: ${v};`);

describe('adaptMarkdownCss', () => {
	it('rewrites a simple heading selector to its .cm-line class', () => {
		const out = adaptMarkdownCss('h1 { color: red; }');
		expect(out).toContain('.cm-line.mlp-line-h1');
	});

	it('rewrites "pre code" to the block-code child selector', () => {
		const out = adaptMarkdownCss('pre code { color: red; }');
		expect(out).toContain('.cm-line.mlp-line-code > *');
	});

	it('maps a checkbox input selector to the checkbox span', () => {
		const out = adaptMarkdownCss('input[type="checkbox"] { accent-color: blue; }');
		expect(out).toContain('.mlp-checkbox');
	});

	it('scopes generic image selectors away from CodeMirror widget buffers', () => {
		const out = adaptMarkdownCss('img { display: block; margin: 1em auto; } table img[align=right] { max-width: 100%; }');
		expect(out).toContain(':is(.mlp-image, .mlp-table-image)');
		expect(out).not.toMatch(/(?:^|\s)img\s*\{/);
		expect(out).not.toContain('table img[align=right]');
	});

	it('maps one-value logical block spacing to both measured edges', () => {
		const out = adaptMarkdownCss('p { padding-block: 3px; margin-block: 4px; }');
		expect(out).toMatch(/\.mlp-line-paragraph-first[^{]*\{[\s\S]*padding-top: 3px/);
		expect(out).toMatch(/\.mlp-line-paragraph-last[^{]*\{[\s\S]*padding-bottom: calc\(3px \+ 4px\)/);
	});

	it('maps two-value logical block spacing as block-start/block-end', () => {
		const out = adaptMarkdownCss('p { padding-block: 1px 2px; margin-block: 3px 4px; }');
		expect(out).toMatch(/\.mlp-line-paragraph-first[^{]*\{[\s\S]*padding-top: 1px/);
		expect(out).toMatch(/\.mlp-line-paragraph-last[^{]*\{[\s\S]*padding-bottom: calc\(2px \+ 4px\)/);
		expect(out).not.toMatch(/padding-bottom: calc\(1px \+ 3px\)/);
	});

	it('maps logical inline spacing as inline-start/inline-end', () => {
		const out = adaptMarkdownCss('p { padding-inline: 5px 6px; margin-inline: 7px 8px; }');
		expect(out).toContain('padding-left: calc(5px + 7px)');
		expect(out).toContain('padding-right: calc(6px + 8px)');
	});

	it('folds physical top and bottom margins into measured padding', () => {
		const out = adaptMarkdownCss('h1 { margin-top: 9px; margin-bottom: 10px; }');
		// Top margins are deliberately dropped because this adapter cannot reproduce
		// CSS margin collapse across independent CodeMirror lines; bottom margins
		// are retained inside the measured last-line box.
		expect(out).not.toContain('padding-top: 9px');
		expect(out).toContain('padding-bottom: 10px');
		expect(out).not.toContain('margin-top');
		expect(out).not.toContain('margin-bottom');
	});

	it('parses commented declarations before distributing measured block spacing', () => {
		const out = adaptMarkdownCss(`p {
			/* keep this annotation */
			margin-top: 0; /* top edge */
			margin-bottom: 12px; /* bottom edge */
		}`);
		expect(out).not.toMatch(/\.cm-line\.mlp-line-paragraph[^{}]*\{[^}]*margin-bottom/);
		expect(out).toMatch(/\.mlp-line-paragraph-last[^{}]*\{[\s\S]*padding-bottom: 12px/);
	});

	it('maps every known block-level tag to its class regardless of declaration content (PBT-03 invariant)', () => {
		fc.assert(
			fc.property(fc.constantFrom(...MAPPED_BLOCK_TAGS), declaration, ([tag, expectedClass], decl) => {
				const out = adaptMarkdownCss(`${tag} { ${decl} }`);
				expect(out).toContain(expectedClass);
			}),
		);
	});

	it('leaves selector lists of untouched tags byte-for-byte identical (PBT-03 invariant)', () => {
		fc.assert(
			fc.property(fc.subarray(UNTOUCHED_TAGS, { minLength: 1, maxLength: 3 }), declaration, (tags, decl) => {
				const css = `${tags.join(', ')} { ${decl} }`;
				expect(adaptMarkdownCss(css)).toBe(css);
			}),
		);
	});
});
