import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { ViewUpdate } from '@codemirror/view';
import { decorationRebuildReason, lineDecorationsField, selectionDecorationContextChanged } from './livePreviewPlugin';
import { blockDecorationsField } from './blockDecorations';
import { footnoteIndexField } from './footnotes';
import { buildLongDocument } from '../quarto/longDocumentFixture';
import { findMathRanges, mathRangesField } from '../quarto/math';
import { changedDecorationRanges } from './decorationRefresh';

function fakeUpdate(
	startState: EditorState,
	state: EditorState,
	flags: Partial<Pick<ViewUpdate, 'docChanged' | 'viewportChanged' | 'selectionSet'>> = {},
): ViewUpdate {
	return {
		startState,
		state,
		docChanged: flags.docChanged ?? false,
		viewportChanged: flags.viewportChanged ?? false,
		selectionSet: flags.selectionSet ?? false,
	} as ViewUpdate;
}

describe('live preview syntax invalidation', () => {
	function semanticState(doc: string): EditorState {
		return EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions: [markdown({ extensions: GFM }), footnoteIndexField, lineDecorationsField, blockDecorationsField],
		});
	}

	function replaceText(state: EditorState, search: string, insert: string): EditorState {
		const from = state.doc.toString().indexOf(search);
		expect(from).toBeGreaterThanOrEqual(0);
		return state.update({ changes: { from, to: from + search.length, insert } }).state;
	}

	function lineClasses(state: EditorState, lineNumber: number): string {
		const lineFrom = state.doc.line(lineNumber).from;
		const classes: string[] = [];
		for (let iter = state.field(lineDecorationsField).iter(); iter.value; iter.next()) {
			if (iter.from === lineFrom) classes.push(String(iter.value.spec.class ?? ''));
		}
		return classes.join(' ');
	}

	function blockWidgetNames(state: EditorState): string[] {
		const names: string[] = [];
		for (let iter = state.field(blockDecorationsField).iter(); iter.value; iter.next()) {
			names.push(iter.value.spec.widget?.constructor.name ?? '');
		}
		return names;
	}

	// Vitest runs in Node here, so it cannot host the real EditorView parseWorker.
	// The first test models the worker's state-only Language.setState transition;
	// the production predicate is intentionally small enough to test directly.
	it('rebuilds when only the syntax tree identity changes', () => {
		const doc = '# heading\n\n**bold**';
		const start = EditorState.create({ doc, extensions: [markdown()] });
		const progressed = EditorState.create({ doc, extensions: [markdown()] });
		expect(syntaxTree(progressed)).not.toBe(syntaxTree(start));
		expect(decorationRebuildReason(fakeUpdate(start, progressed))).toBe('syntaxTreeChanged');
	});

	it('preserves the existing reason priority and ignores unrelated updates', () => {
		const state = EditorState.create({ doc: '# heading', extensions: [markdown()] });
		expect(decorationRebuildReason(fakeUpdate(state, state))).toBeNull();
		expect(decorationRebuildReason(fakeUpdate(state, state, { selectionSet: true }))).toBe('selectionSet');
		expect(decorationRebuildReason(fakeUpdate(state, state, { viewportChanged: true }))).toBe('viewportChanged');
		expect(decorationRebuildReason(fakeUpdate(state, state, { docChanged: true }))).toBe('docChanged');
	});

	it('does not invalidate full-document line/block decorations for ordinary cursor moves', () => {
		const doc = '# Heading\n\nordinary paragraph text';
		const extensions = [markdown()];
		const before = EditorState.create({ doc, selection: { anchor: doc.indexOf('ordinary') }, extensions });
		const after = before.update({ selection: { anchor: doc.indexOf('paragraph') } }).state;
		expect(selectionDecorationContextChanged(before, after, 'line')).toBe(false);
		expect(selectionDecorationContextChanged(before, after, 'block')).toBe(false);
	});

	it('invalidates when the cursor enters a rendered table or fenced block boundary', () => {
		const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\nend';
		const extensions = [markdown({ extensions: GFM })];
		const outside = EditorState.create({ doc, selection: { anchor: doc.length }, extensions });
		const table = outside.update({ selection: { anchor: doc.indexOf('| 1') } }).state;
		expect(selectionDecorationContextChanged(outside, table, 'block')).toBe(true);
		const fenceOpen = outside.update({ selection: { anchor: doc.indexOf('```ts') } }).state;
		const fenceBody = fenceOpen.update({ selection: { anchor: doc.indexOf('const') } }).state;
		expect(selectionDecorationContextChanged(fenceOpen, fenceBody, 'line')).toBe(true);
	});

	it.each([
		['heading to paragraph', '# Heading\n\ntail', '# ', '', 'mlp-line-h1', false, 'mlp-line-paragraph', true],
		['paragraph to heading', 'Heading\n\ntail', 'Heading', '# Heading', 'mlp-line-paragraph', false, 'mlp-line-h1', true],
		['paragraph to list', 'item\n\ntail', 'item', '- item', 'mlp-line-paragraph', false, 'mlp-line-list', true],
		['list to paragraph', '- item\n\ntail', '- ', '', 'mlp-line-list', false, 'mlp-line-paragraph', true],
		['paragraph to blockquote', 'quote\n\ntail', 'quote', '> quote', 'mlp-line-paragraph', false, 'mlp-line-quote', true],
		['blockquote to paragraph', '> quote\n\ntail', '> ', '', 'mlp-line-quote', false, 'mlp-line-paragraph', true],
	])('refreshes line semantics after %s', (_name, doc, search, insert, stale, staleExpected, fresh, freshExpected) => {
		const after = replaceText(semanticState(doc), search, insert);
		expect(lineClasses(after, 1).includes(stale)).toBe(staleExpected);
		expect(lineClasses(after, 1).includes(fresh)).toBe(freshExpected);
	});

	it('refreshes paragraph-owned separator-line semantics in both directions', () => {
		const paragraph = replaceText(semanticState('# Heading\n\ntail'), '# ', '');
		expect(lineClasses(paragraph, 2)).toContain('mlp-line-paragraph');

		const heading = replaceText(semanticState('Heading\n\ntail'), 'Heading', '# Heading');
		expect(lineClasses(heading, 2)).not.toContain('mlp-line-paragraph');
	});

	it('refreshes every affected line when a fenced code block is created and removed', () => {
		const plain = semanticState('intro\nbody\n```\n\ntail');
		const fenced = replaceText(plain, 'body', '```ts\nbody');
		// Hidden fence-marker lines deliberately stay undecorated; the body must
		// acquire code semantics even though the edit itself happened above it.
		expect(lineClasses(fenced, 3)).toContain('mlp-line-code');

		const reopened = replaceText(fenced, '```ts\n', '');
		expect(lineClasses(reopened, 2)).not.toContain('mlp-line-code');
		expect(lineClasses(reopened, 2)).toContain('mlp-line-paragraph');
	});

	it('refreshes line and block semantics when a code fence changes to and from Mermaid', () => {
		const code = semanticState('```js\ngraph TD; A-->B\n```\n\ntail');
		const mermaid = replaceText(code, 'js', 'mermaid');
		expect(blockWidgetNames(mermaid)).toContain('MermaidWidget');
		expect(lineClasses(mermaid, 2)).not.toContain('mlp-line-code');

		const restored = replaceText(mermaid, 'mermaid', 'js');
		expect(blockWidgetNames(restored)).not.toContain('MermaidWidget');
		expect(lineClasses(restored, 2)).toContain('mlp-line-code');
	});

	it('refreshes the rendered block after a table structural edit', () => {
		const plain = semanticState('| a | b |\n| nope | nope |\n| 1 | 2 |\n\ntail');
		const table = replaceText(plain, '| nope | nope |', '| --- | --- |');
		expect(blockWidgetNames(table)).toContain('TableWidget');

		const broken = replaceText(table, '| --- | --- |', '| nope | nope |');
		expect(blockWidgetNames(broken)).not.toContain('TableWidget');
	});

	it('keeps semantic invalidation local in a long document', () => {
		const doc = ['# target', ...Array.from({ length: 4_000 }, (_, i) => `line ${i}`), '# tail'].join('\n');
		const before = semanticState(doc);
		const transaction = before.update({ changes: { from: 0, to: 1, insert: '' } });
		const ranges = changedDecorationRanges(transaction);
		expect(ranges.length).toBeGreaterThan(0);
		expect(Math.max(...ranges.map((range) => range.to))).toBeLessThan(doc.length - '# tail'.length);
	});

	it('rebuilds the non-syntax front matter widget after a YAML edit', () => {
		const before = semanticState('---\ntitle: one\n---\n\nbody');
		const previousWidget = before.field(blockDecorationsField).iter().value?.spec.widget;
		const after = replaceText(before, 'one', 'two');
		const nextWidget = after.field(blockDecorationsField).iter().value?.spec.widget;
		expect(previousWidget).toBeDefined();
		expect(nextWidget).toBeDefined();
		expect(nextWidget).not.toBe(previousWidget);
	});
});

describe('long document regression inputs', () => {
	for (const lineCount of [5_000, 10_000, 25_000, 50_000]) {
		it(`builds a deterministic ${lineCount}-line document without forcing a full parse`, () => {
			const doc = buildLongDocument(lineCount);
			const state = EditorState.create({ doc, extensions: [markdown()] });
			expect(doc.split('\n').length).toBe(lineCount);
			for (const marker of ['MARKER 25', 'MARKER 50', 'MARKER 75', 'MARKER 90', 'MARKER 99']) {
				expect(doc).toContain(marker);
			}
			expect(doc.split('\n')[Math.floor(lineCount * 0.99)]).toBe('# MARKER 99');
			// Do not call ensureSyntaxTree(..., doc.length) here. This assertion records
			// the initial state expected before CodeMirror's background parser advances.
			expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false);
		});
	}

	for (const lineCount of [5_000, 10_000, 25_000, 50_000]) {
		it(`keeps full line/block decoration sets for an ordinary cursor move in ${lineCount} lines`, () => {
			const doc = buildLongDocument(lineCount);
			const state = EditorState.create({
				doc,
				selection: { anchor: Math.min(20, doc.length) },
				extensions: [markdown({ extensions: GFM }), footnoteIndexField, lineDecorationsField, blockDecorationsField],
			});
			const linesBefore = state.field(lineDecorationsField);
			const blocksBefore = state.field(blockDecorationsField);
			const started = performance.now();
			const moved = state.update({ selection: { anchor: Math.min(21, doc.length) } }).state;
			const elapsed = performance.now() - started;
			console.log(`decoration selection ${lineCount} lines: ${elapsed.toFixed(2)} ms (0 full rebuilds)`);
			expect(moved.field(lineDecorationsField)).toBe(linesBefore);
			expect(moved.field(blockDecorationsField)).toBe(blocksBefore);
		});
	}

	it('measures the current full-document math scan cost without changing it', () => {
		for (const lineCount of [10_000, 20_000]) {
			const doc = buildLongDocument(lineCount);
			const start = performance.now();
			const ranges = findMathRanges(doc);
			const duration = performance.now() - start;
			console.log(`math scan ${lineCount} lines: ${duration.toFixed(2)} ms (${ranges.length} ranges)`);
			expect(ranges.length).toBeGreaterThan(500);
		}
	});

	it('records cached delimiter-free edit cost alongside the full-scan baseline', () => {
		const doc = buildLongDocument(20_000);
		const initial = EditorState.create({ doc, extensions: [mathRangesField] });
		const original = initial.field(mathRangesField);
		const fullScanStart = performance.now();
		const fullScan = findMathRanges(doc);
		const fullScanMs = performance.now() - fullScanStart;
		const editStart = performance.now();
		const edited = initial.update({ changes: { from: 0, to: 0, insert: 'prefix ' } }).state;
		const editMs = performance.now() - editStart;
		const mapped = edited.field(mathRangesField);
		console.log(`math edit 20k lines: ${editMs.toFixed(2)} ms (cached ${mapped.length} ranges; full scan ${fullScanMs.toFixed(2)} ms)`);
		expect(mapped).toHaveLength(fullScan.length);
		expect(mapped[0].from).toBe(original[0].from + 7);
	});
});
