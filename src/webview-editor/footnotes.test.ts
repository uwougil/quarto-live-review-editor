import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
	footnoteIndexField,
	footnoteAtomicRangesField,
	footnoteNavigationEffect,
	footnoteNavigationField,
	FootnoteReferenceWidget,
	scanFootnotes,
} from './footnotes';

describe('scanFootnotes', () => {
	it('indexes valid references and definitions in first-reference order', () => {
		const text = 'A [^later] and [^first] and [^later].\n\n[^first]: first\n[^later]: later';
		const index = scanFootnotes(text);
		expect(index.references.map((reference) => [reference.id, reference.ordinal])).toEqual([
			['later', 1],
			['first', 2],
			['later', 1],
		]);
		expect(index.definitions.get('first')?.markerFrom).toBe(text.lastIndexOf('[^first]'));
	});

	it('leaves missing and duplicate definitions invalid', () => {
		const text = '[^missing] [^duplicate]\n\n[^duplicate]: one\n[^duplicate]: two';
		const index = scanFootnotes(text);
		expect(index.references).toEqual([]);
		expect(index.definitions.has('missing')).toBe(false);
		expect(index.invalidIds).toEqual(new Set(['duplicate']));
	});

	it('does not interpret escaped, inline-code, frontmatter, or fenced references', () => {
		const tick = String.fromCharCode(96);
		const text = [
			'---',
			'key: "[^frontmatter]"',
			'---',
			'Escaped \\[^escaped] and ' + tick + '[^inline]' + tick + ' and [^real].',
			'~~~~md',
			'[^fenced]',
			'~~~~',
			'[^real]: definition',
		].join('\n');
		const index = scanFootnotes(text);
		expect(index.references.map((reference) => reference.id)).toEqual(['real']);
		expect(index.references[0].ordinal).toBe(1);
	});
});

describe('footnote navigation state', () => {
	it('maps the last reference position through edits and records navigation', () => {
		const state = EditorState.create({
			doc: '[^a]\n\n[^a]: note',
			extensions: [footnoteIndexField, footnoteNavigationField],
		});
		const referenceFrom = state.doc.toString().indexOf('[^a]');
		const navigated = state.update({ effects: footnoteNavigationEffect.of({ id: 'a', referenceFrom }) }).state;
		expect(navigated.field(footnoteNavigationField).lastReferenceFrom.get('a')).toBe(referenceFrom);
		const edited = navigated.update({ changes: { from: 0, to: 0, insert: 'x' } }).state;
		expect(edited.field(footnoteNavigationField).lastReferenceFrom.get('a')).toBe(referenceFrom + 1);
	});
});

describe('footnote atomic ranges', () => {
	function atomicRangesAt(state: EditorState): Array<{ from: number; to: number }> {
		const ranges: Array<{ from: number; to: number }> = [];
		state.field(footnoteAtomicRangesField).between(0, state.doc.length, (from, to) => {
			ranges.push({ from, to });
		});
		return ranges;
	}

	it('keeps adjacent rendered references atomic at their shared boundary', () => {
		const text = '[^a][^b]\n\n[^a]: first\n[^b]: second';
		const boundary = text.indexOf('[^b]');
		const state = EditorState.create({
			doc: text,
			selection: { anchor: boundary },
			extensions: [footnoteIndexField, footnoteAtomicRangesField],
		});
		expect(atomicRangesAt(state)).toEqual([
			{ from: 0, to: 4 },
			{ from: boundary, to: boundary + 4 },
		]);
	});

	it('removes only the reference containing a programmatic caret', () => {
		const text = '[^a][^b]\n\n[^a]: first\n[^b]: second';
		const boundary = text.indexOf('[^b]');
		const state = EditorState.create({
			doc: text,
			selection: { anchor: boundary + 1 },
			extensions: [footnoteIndexField, footnoteAtomicRangesField],
		});
		expect(atomicRangesAt(state)).toEqual([{ from: 0, to: 4 }]);
	});
});

describe('footnote reference widgets', () => {
	it('rebuilds when a reference moves, while preserving identity otherwise', () => {
		const reference = { id: 'a', from: 2, to: 6, ordinal: 1 };
		const widget = new FootnoteReferenceWidget(reference);
		expect(widget.eq(new FootnoteReferenceWidget({ ...reference }))).toBe(true);
		expect(widget.eq(new FootnoteReferenceWidget({ ...reference, from: 3, to: 7 }))).toBe(false);
	});
});
