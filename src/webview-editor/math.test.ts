import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { findMathRanges, mathRangeTouchesSelection, mathRangesField } from './math';

describe('findMathRanges', () => {
	it('finds inline and display math', () => {
		expect(findMathRanges('a $x^2$ b\n\n$$\ny = mx + b\n$$')).toEqual([
			{ from: 2, to: 7, display: false, tex: 'x^2' },
			{ from: 11, to: 27, display: true, tex: 'y = mx + b' },
		]);
	});

	it('does not parse front matter, code spans, fenced code, or escaped dollars', () => {
		const text = [
			'---',
			'title: "$not math$"',
			'---',
			'`$code$` and \\$safe\\$',
			'',
			'```python',
			'price = "$100"',
			'```',
			'$ok$',
		].join('\n');
		expect(findMathRanges(text).map((range) => range.tex)).toEqual(['ok']);
	});

	it('does not parse display delimiters inside an inline code span', () => {
		expect(findMathRanges('`$$not math$$` and $$x$$').map((range) => range.tex)).toEqual(['x']);
	});

	it('keeps exact offsets in LF and CRLF documents', () => {
		const lf = ['prefix text', 'inline $a+b$', '', '$$', 'F(k) = \\int_0^1 f(k)\\,dk', '$$'].join('\n');
		const crlf = lf.replaceAll('\n', '\r\n');
		const lfRanges = findMathRanges(lf);
		const crlfRanges = findMathRanges(crlf);
		expect(lfRanges.map((range) => lf.slice(range.from, range.to))).toEqual(['$a+b$', '$$\nF(k) = \\int_0^1 f(k)\\,dk\n$$']);
		expect(crlfRanges.map((range) => crlf.slice(range.from, range.to))).toEqual(['$a+b$', '$$\r\nF(k) = \\int_0^1 f(k)\\,dk\r\n$$']);
		expect(crlfRanges[0].from).toBe(lfRanges[0].from + 1);
		expect(crlfRanges[1].from).toBe(lfRanges[1].from + 3);
	});

	it('handles mixed CRLF inline/display math after preceding text', () => {
		const text = '第一行\r\n第二行 $x$\r\n说明\r\n$$\r\ny = mx + b\r\n$$\r\n结束';
		const ranges = findMathRanges(text);
		expect(ranges.map((range) => ({ source: text.slice(range.from, range.to), tex: range.tex, display: range.display }))).toEqual([
			{ source: '$x$', tex: 'x', display: false },
			{ source: '$$\r\ny = mx + b\r\n$$', tex: 'y = mx + b', display: true },
		]);
	});

	it('does not parse escaped dollars, currency text, code spans, or fenced code', () => {
		const text = [
			'escaped \\$x\\$ and price $100',
			'`$inline code$` and $valid$',
			'```{python}',
			'price = "$not math$"',
			'```',
		].join('\r\n');
		expect(findMathRanges(text).map((range) => range.tex)).toEqual(['valid']);
	});

	it('reuses cached ranges for selection changes and updates them after edits', () => {
		const initial = EditorState.create({ doc: 'A $x$ B', extensions: [mathRangesField] });
		const cached = initial.field(mathRangesField);
		const moved = initial.update({ selection: { anchor: 0 } }).state;
		expect(moved.field(mathRangesField)).toBe(cached);
		const edited = moved.update({ changes: { from: 3, to: 4, insert: 'y' } }).state;
		expect(edited.field(mathRangesField)).not.toBe(cached);
		expect(edited.field(mathRangesField)[0].tex).toBe('y');
	});

	it('maps cached ranges for a delimiter-free edit before a formula', () => {
		const initial = EditorState.create({ doc: 'intro\n\n$a$\n', extensions: [mathRangesField] });
		const original = initial.field(mathRangesField)[0];
		const edited = initial.update({ changes: { from: 0, to: 0, insert: 'prefix ' } }).state;
		const next = edited.field(mathRangesField)[0];
		expect(next).toEqual({ ...original, from: original.from + 7, to: original.to + 7 });
	});

	it('rescans edits that can change delimiters, protected contexts, or multiline TeX', () => {
		const cases = [
			{
				name: 'inline body',
				text: 'before $x$ after',
				changes: { from: 8, to: 9, insert: 'y' },
				expected: ['y'],
			},
			{
				name: 'add delimiter',
				text: 'before x after',
				changes: { from: 7, to: 8, insert: '$x$' },
				expected: ['x'],
			},
			{
				name: 'remove delimiter',
				text: 'before $x$ after',
				changes: { from: 7, to: 8, insert: '' },
				expected: [],
			},
			{
				name: 'multiline display body',
				text: '$$\nx = 1\n$$',
				changes: { from: 7, to: 8, insert: '2' },
				expected: ['x = 2'],
			},
			{
				name: 'fenced code',
				text: '```python\nprice = 1\n```',
				changes: { from: 19, to: 20, insert: '$x$' },
				expected: [],
			},
			{
				name: 'frontmatter',
				text: '---\ntitle: plain\n---\ntext',
				changes: { from: 12, to: 17, insert: '"$x$"' },
				expected: [],
			},
			{
				name: 'escaped dollar',
				text: '$x$ and text',
				changes: { from: 0, to: 0, insert: '\\' },
				expected: [],
			},
			{
				name: 'code span',
				text: '`code`',
				changes: { from: 1, to: 5, insert: '$x$' },
				expected: [],
			},
		];
		for (const testCase of cases) {
			const initial = EditorState.create({ doc: testCase.text, extensions: [mathRangesField] });
			const edited = initial.update({ changes: testCase.changes }).state;
			expect(edited.field(mathRangesField).map((range) => range.tex), testCase.name).toEqual(testCase.expected);
		}
	});

	it('falls back to a full scan for multiple edits in one transaction', () => {
		const initial = EditorState.create({ doc: 'a $x$ b $y$', extensions: [mathRangesField] });
		const edited = initial.update({
			changes: [
				{ from: 0, to: 0, insert: 'prefix ' },
				{ from: 6, to: 7, insert: 'z' },
			],
		}).state;
		expect(edited.field(mathRangesField).map((range) => range.tex)).toEqual(['x', 'y']);
	});

	it('reveals source when a caret or selection intersects a range', () => {
		const text = 'A $x$ B';
		const range = findMathRanges(text)[0];
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 3 } }), range)).toBe(true);
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 0 } }), range)).toBe(false);
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 0, head: 4 } }), range)).toBe(true);
	});
});
