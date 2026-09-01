import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { parse as parseYaml } from 'yaml';
import { MermaidWidget } from './mermaidWidget';
import { DrawioWidget } from './drawioWidget';
import { isDiagramLang } from './diagramLang';
import { buildTableWidget, isLineAligned, alignedBlockRange } from './livePreviewPlugin';
import { blockCursorTouchesRange, noteRevealed, onPointerRelease } from './cmUtils';
import { detectFrontmatter, FrontmatterWidget, FrontmatterEmptyWidget, FrontmatterErrorWidget } from './frontmatterWidget';

/**
 * CodeMirror 6 forbids block decorations (block widgets / block-replacing
 * ranges) from being supplied by a ViewPlugin — doing so throws
 * "Block decorations may not be specified via plugins" while the EditorView is
 * being constructed, which blanks the whole editor. The rendered mermaid
 * diagrams and tables are block-level, so they are provided here through a
 * StateField instead, which is the sanctioned source for block decorations.
 */
function buildBlockDecorations(state: EditorState): DecorationSet {
	const decorations: Range<Decoration>[] = [];
	const tree = syntaxTree(state);

	// Frontmatter has no dedicated `@lezer/markdown` node, so it's detected by a
	// plain line scan (see frontmatterWidget.ts) rather than via tree.iterate()
	// below. Computed once up front so the tree walk can both render it and skip
	// any node the parser mistakenly finds *entirely inside* it (e.g. a YAML line
	// that happens to look like a table row) — without that guard, a
	// Table/FencedCode decoration overlapping this range would violate the
	// sorted, non-overlapping range requirement `Decoration.set` enforces.
	// The skip below only fires for nodes *fully contained* in [fm.from, fm.to),
	// never for an ancestor that merely spans across the block (fm.from is
	// always 0, so the tree's own root node always satisfies a naive "any
	// overlap" test — that used to make `tree.iterate` skip its own root and
	// silently produce zero decorations for the *entire* document whenever
	// frontmatter was present, not just inside the frontmatter block).
	const fm = detectFrontmatter(state);
	const fmRevealed = fm ? blockCursorTouchesRange(state, fm.from, fm.to) : false;
	if (fm) noteRevealed(fm.from, fm.to, fmRevealed);
	if (fm && !fmRevealed) {
		let widget: WidgetType;
		try {
			const data = parseYaml(fm.yamlText) ?? {};
			const entries = Object.entries(data);
			widget = entries.length === 0 ? new FrontmatterEmptyWidget() : new FrontmatterWidget(entries);
		} catch (err) {
			widget = new FrontmatterErrorWidget(err instanceof Error ? err.message : String(err));
		}
		decorations.push(Decoration.replace({ widget, block: true }).range(fm.from, fm.to));
	}

	tree.iterate({
		enter: (node) => {
			if (fm && node.from >= fm.from && node.to <= fm.to) return false;
			if (node.name === 'FencedCode') {
				const infoNode = node.node.getChild('CodeInfo');
				const lang = infoNode ? state.sliceDoc(infoNode.from, infoNode.to).trim().toLowerCase() : '';
				const diagram = isDiagramLang(lang);
				if (!diagram) return;
				const diagramRevealed = blockCursorTouchesRange(state, node.from, node.to);
				noteRevealed(node.from, node.to, diagramRevealed);
				if (diagramRevealed) return;
				if (!isLineAligned(state, node.from, node.to)) return;
				const textNode = node.node.getChild('CodeText');
				const code = textNode ? state.sliceDoc(textNode.from, textNode.to) : '';
				if (!code.trim()) return;
				const widget = diagram === 'mermaid' ? new MermaidWidget(code) : new DrawioWidget(code);
				decorations.push(Decoration.replace({ widget, block: true }).range(node.from, node.to));
				return false;
			}
			if (node.name === 'Table') {
				const tableRevealed = blockCursorTouchesRange(state, node.from, node.to);
				noteRevealed(node.from, node.to, tableRevealed);
				if (tableRevealed) return;
				const range = alignedBlockRange(state, node.from, node.to);
				if (!range) return;
				decorations.push(
					Decoration.replace({ widget: buildTableWidget(state, node), block: true }).range(range.from, range.to),
				);
				return false;
			}
		},
	});

	return Decoration.set(decorations, true);
}

/** Asks the field below to rebuild even though the editor state is unchanged. */
const refreshBlocks = StateEffect.define<null>();

/**
 * Nudges the editor into rebuilding its block decorations when a drag ends.
 *
 * `blockCursorTouchesRange` answers differently once the mouse comes up (see
 * cmUtils.ts), but a release is not a state change, so nothing would otherwise
 * schedule the rebuild — a block the caret landed inside during a drag would
 * stay rendered until the next unrelated edit. Dispatching an empty transaction
 * re-runs the field's `update` with the selection unchanged.
 */
/** Whether two decoration sets cover exactly the same ranges. */
function sameRanges(a: DecorationSet, b: DecorationSet): boolean {
	if (a.size !== b.size) return false;
	const ia = a.iter();
	const ib = b.iter();
	while (ia.value || ib.value) {
		if (!ia.value || !ib.value || ia.from !== ib.from || ia.to !== ib.to) return false;
		ia.next();
		ib.next();
	}
	return true;
}

export const dragReleaseRefresh = ViewPlugin.fromClass(
	class {
		private readonly off: () => void;
		constructor(view: EditorView) {
			this.off = onPointerRelease(() => {
				// The release fires during the DOM event; let CodeMirror finish
				// applying its own selection change for that gesture first.
				setTimeout(() => {
					if (!view.dom.isConnected) return;
					// Only when the rebuild would actually change something. The
					// release sets the post-gesture suppression, so an unconditional
					// refresh re-rendered the very block whose source the user had
					// just opened — it flashed back to a rendered table for a frame,
					// until the next keystroke lifted the suppression again.
					if (sameRanges(buildBlockDecorations(view.state), view.state.field(blockDecorationsField))) return;
					view.dispatch({ effects: refreshBlocks.of(null) });
				}, 0);
			});
		}
		destroy() {
			this.off();
		}
	},
);

export const blockDecorationsField = StateField.define<DecorationSet>({
	create(state) {
		return buildBlockDecorations(state);
	},
	update(value, tr) {
		// Rebuild on edits, on selection moves (a cursor entering a block reveals
		// its raw source), and when background parsing advances the syntax tree —
		// the latter matters because blocks near the end of a long document aren't
		// in the tree yet on the first render.
		if (
			tr.docChanged ||
			tr.selection ||
			tr.effects.some((e) => e.is(refreshBlocks)) ||
			syntaxTree(tr.startState) !== syntaxTree(tr.state)
		) {
			return buildBlockDecorations(tr.state);
		}
		return value;
	},
	provide: (field) => EditorView.decorations.from(field),
});
