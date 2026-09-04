import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { ViewUpdate } from '@codemirror/view';
import { decorationRebuildReason } from './livePreviewPlugin';
import { buildLongDocument } from '../quarto/longDocumentFixture';
import { findMathRanges } from '../quarto/math';

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
});

describe('long document regression inputs', () => {
	for (const lineCount of [10_000, 20_000]) {
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
});
