import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
	footnoteIndexField,
	footnoteNavigationEffect,
	footnoteNavigationField,
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
