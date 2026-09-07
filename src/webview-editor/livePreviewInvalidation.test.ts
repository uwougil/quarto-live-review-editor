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
