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

	it('reveals source when a caret or selection intersects a range', () => {
		const text = 'A $x$ B';
		const range = findMathRanges(text)[0];
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 3 } }), range)).toBe(true);
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 0 } }), range)).toBe(false);
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 0, head: 4 } }), range)).toBe(true);
	});
});
