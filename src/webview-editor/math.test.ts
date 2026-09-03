import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { findMathRanges, mathRangeTouchesSelection } from './math';

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

	it('reveals source when a caret or selection intersects a range', () => {
		const text = 'A $x$ B';
		const range = findMathRanges(text)[0];
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 3 } }), range)).toBe(true);
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 0 } }), range)).toBe(false);
		expect(mathRangeTouchesSelection(EditorState.create({ doc: text, selection: { anchor: 0, head: 4 } }), range)).toBe(true);
	});
});
