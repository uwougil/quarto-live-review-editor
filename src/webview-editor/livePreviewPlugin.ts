import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { Range, EditorState } from '@codemirror/state';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { cursorTouchesRange } from './cmUtils';
import { wrapBlockWidget } from './blockWidgetWrap';
import { detectFrontmatter } from './frontmatterWidget';
import { renderInlineInto, type CellInlineHooks } from './tableCellInline';

const HEADING_LINE_CLASS: Record<string, string> = {
	ATXHeading1: 'mlp-line-h1',
	ATXHeading2: 'mlp-line-h2',
	ATXHeading3: 'mlp-line-h3',
	ATXHeading4: 'mlp-line-h4',
	ATXHeading5: 'mlp-line-h5',
	ATXHeading6: 'mlp-line-h6',
};

export function isLineAligned(state: EditorState, from: number, to: number): boolean {
	return from === state.doc.lineAt(from).from && to === state.doc.lineAt(to).to;
}

// A block-level decoration (rich table widget) requires `to` to land exactly
// at the end of its line, but `from` doesn't strictly have to be a line
// start — it may sit after pure indentation, as for a table nested under a
// list item ("  | a | b |"). Widening `from` back to the start of its own
// line (which is safe precisely because nothing but whitespace precedes it)
// satisfies CodeMirror's line-alignment requirement for block decorations
// without swallowing unrelated content sharing that line (e.g. a list
// marker, which always lives on a different line from an indented table).
export function alignedBlockRange(state: EditorState, from: number, to: number): { from: number; to: number } | null {
	const toLine = state.doc.lineAt(to);
	if (to !== toLine.to) return null;
	const fromLine = state.doc.lineAt(from);
	if (fromLine.from === from) return { from, to };
	return /^[ \t]*$/.test(state.sliceDoc(fromLine.from, from)) ? { from: fromLine.from, to } : null;
}

/**
 * End offset of the empty line directly after `blockTo`, or `null` when there
 * is none (end of document, or the next line has content). Lets a paragraph
 * claim the blank line that separates it from whatever follows — see the
 * `Paragraph` case in `buildDecorations` for why.
 */
export function blankLineAfter(state: EditorState, blockTo: number): number | null {
	const lastLine = state.doc.lineAt(blockTo);
	if (lastLine.number >= state.doc.lines) return null;
	const next = state.doc.line(lastLine.number + 1);
	return next.text === '' ? next.to : null;
}

// The webview's document lives at a `vscode-webview://` origin, not the
// actual folder holding the `.md` file — a Markdown image path like
// `assets/foo.png`, meant to be relative to that folder, is meaningless
// resolved against the webview's own origin instead, and the browser silently
// fails to load it. `setImageBaseUri` is called once per `init` message with
// a webview-loadable URI for the document's folder (see documentSync.ts), and
// `resolveImageSrc` resolves a relative path against it at render time —
// only the *displayed* `<img src>` is rewritten; the underlying Markdown
// source keeps the plain, portable relative path.
let imageBaseUri = '';
export function setImageBaseUri(uri: string): void {
	imageBaseUri = uri;
}

const ABSOLUTE_SRC_RE = /^([a-z][a-z0-9+.-]*:)/i;

export function resolveImageSrc(src: string, baseUri: string): string {
	if (ABSOLUTE_SRC_RE.test(src)) return src; // already a full URL (https:, data:, vscode-webview:, …)
	if (!baseUri) return src;
	try {
		return new URL(src, baseUri).toString();
	} catch {
		return src;
	}
}

// Cells render their own images, so they need the same base-URI rewriting the
// document's ImageWidget applies. Read through a getter rather than captured:
// `setImageBaseUri` runs on the `init` message, potentially after this module
// is first evaluated.
const cellInlineHooks: CellInlineHooks = {
	resolveImageSrc: (src) => resolveImageSrc(src, imageBaseUri),
};

class ImageWidget extends WidgetType {
	constructor(
		private readonly src: string,
		private readonly alt: string,
	) {
		super();
	}
	eq(other: ImageWidget): boolean {
		return other.src === this.src && other.alt === this.alt;
	}
	toDOM(view: EditorView): HTMLElement {
		const img = document.createElement('img');
		img.src = resolveImageSrc(this.src, imageBaseUri);
		img.alt = this.alt;
		img.className = 'mlp-image';
		// An <img> is zero-height until its bytes arrive, so the line CodeMirror
		// measures at mount time is nothing like the line the user ends up seeing.
		// CodeMirror can't observe the load, so ask it to re-measure once the real
		// dimensions are in (and on failure, when the broken-image box settles).
		const remeasure = () => view.requestMeasure();
		img.addEventListener('load', remeasure);
		img.addEventListener('error', remeasure);
		return img;
	}
}

// CodeMirror calibrates its "typical line height" estimate (used to figure out
// how far to move for one line on ArrowUp/ArrowDown, among other things) by
// measuring the first short, plain-text line it finds whose only DOM content is
// a single text node — see `measureTextSize` in @codemirror/view. A hidden
// marker built via a bare `Decoration.replace({})` leaves the rest of the line
// as exactly that: one plain text node. For a heading line (much taller than
// body text via font-size/padding/margin/border) that makes it eligible as the
// sample, poisoning the estimate for the whole document and causing
// ArrowUp/ArrowDown to overshoot by a line at a time once it walks past one.
// Backing every hidden marker with this zero-size widget instead gives the
// line an extra, non-text DOM child, which disqualifies it from that scan.
class HiddenMarkerWidget extends WidgetType {
	eq(): boolean {
		return true;
	}
	toDOM(): HTMLElement {
		return document.createElement('span');
	}
	get estimatedHeight(): number {
		return 0;
	}
}
const hiddenMarker = new HiddenMarkerWidget();
const hiddenMarkerDeco = Decoration.replace({ widget: hiddenMarker });

class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}
	toDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = 'mlp-bullet';
		span.textContent = '•';
		return span;
	}
}

class CheckboxWidget extends WidgetType {
	constructor(
		private readonly checked: boolean,
		private readonly markerFrom: number,
	) {
		super();
	}
	eq(other: CheckboxWidget): boolean {
		return other.checked === this.checked && other.markerFrom === this.markerFrom;
	}
	toDOM(view: EditorView): HTMLElement {
		const box = document.createElement('span');
		box.className = 'mlp-checkbox' + (this.checked ? ' mlp-checkbox-checked' : '');
		box.setAttribute('role', 'checkbox');
		box.setAttribute('aria-checked', String(this.checked));
		box.addEventListener('mousedown', (event) => {
			event.preventDefault();
			// The marker is "[ ]" / "[x]"; the state character sits at markerFrom + 1.
			const stateChar = view.state.sliceDoc(this.markerFrom + 1, this.markerFrom + 2);
			const insert = stateChar.toLowerCase() === 'x' ? ' ' : 'x';
			view.dispatch({ changes: { from: this.markerFrom + 1, to: this.markerFrom + 2, insert } });
		});
		return box;
	}
	ignoreEvent(): boolean {
		return false;
	}
}

export type ColumnAlign = 'left' | 'center' | 'right' | null;

/**
 * Builds the `<table>` for a parsed table model. Split out of `TableWidget` so
 * the rendered markup can be asserted on directly, without an `EditorView`.
 */
export function renderTableElement(model: TableModel, hooks: CellInlineHooks): HTMLElement {
	const table = document.createElement('table');
	table.className = 'mlp-table';
	model.rows.forEach((cells, rowIndex) => {
		const tr = document.createElement('tr');
		cells.forEach((cellText, columnIndex) => {
			const cell = document.createElement(rowIndex < model.headerRowCount ? 'th' : 'td');
			const align = model.align[columnIndex];
			if (align) cell.style.textAlign = align;
			renderInlineInto(cell, cellText, hooks);
			tr.appendChild(cell);
		});
		table.appendChild(tr);
	});
	return table;
}

class TableWidget extends WidgetType {
	constructor(
		private readonly rows: string[][],
		private readonly headerRowCount: number,
		private readonly align: ColumnAlign[],
	) {
		super();
	}
	eq(other: TableWidget): boolean {
		return (
			JSON.stringify(other.rows) === JSON.stringify(this.rows) &&
			other.headerRowCount === this.headerRowCount &&
			JSON.stringify(other.align) === JSON.stringify(this.align)
		);
	}
	toDOM(view: EditorView): HTMLElement {
		const table = renderTableElement({ rows: this.rows, headerRowCount: this.headerRowCount, align: this.align }, cellInlineHooks);
		table.addEventListener('mousedown', (event) => {
			event.preventDefault();
			const pos = view.posAtDOM(table);
			view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
			view.focus();
		});
		return wrapBlockWidget(table);
	}
	ignoreEvent(): boolean {
		return false;
	}
}

// @lezer/markdown's table parser only emits a `TableCell` node for cells that
// contain non-whitespace content — an empty cell (e.g. the middle column of
// `| a | | c |`) produces no node at all. Reading cells via `getChildren`
// therefore silently drops empty cells and shifts every later column left.
// Splitting the row's raw text ourselves (mirroring the parser's own
// leading/trailing-pipe trimming) keeps empty cells in place.
export function readCells(state: EditorState, rowNode: SyntaxNode): string[] {
	const text = state.sliceDoc(rowNode.from, rowNode.to);
	const cells: string[] = [];
	let cell = '';
	let escaped = false;
	for (const ch of text) {
		if (ch === '|' && !escaped) {
			cells.push(cell);
			cell = '';
			escaped = false;
			continue;
		}
		cell += ch;
		escaped = !escaped && ch === '\\';
	}
	cells.push(cell);
	// A leading/trailing pipe produces a bounding empty segment, not a column.
	if (cells.length > 1 && cells[0].trim() === '') cells.shift();
	if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
	return cells.map((c) => c.trim());
}

/**
 * Per-column alignment from a table's delimiter row (`|:--|:-:|--:|`).
 *
 * The row sits directly under `Table` as the one multi-character
 * `TableDelimiter` child — the single "|" delimiters inside header/data rows
 * are nested under those rows instead, never under `Table` itself.
 */
export function readColumnAlign(state: EditorState, tableNode: SyntaxNode): ColumnAlign[] {
	for (const child of tableNode.getChildren('TableDelimiter')) {
		const text = state.sliceDoc(child.from, child.to);
		if (text.length <= 1) continue;
		return splitDelimiterCells(text).map((spec) => {
			const left = spec.startsWith(':');
			const right = spec.endsWith(':');
			if (left && right) return 'center';
			if (right) return 'right';
			if (left) return 'left';
			return null;
		});
	}
	return [];
}

/** Splits a delimiter row into its per-column specs (":--", ":-:", "--:", "-"). */
function splitDelimiterCells(text: string): string[] {
	const cells = text.split('|').map((c) => c.trim());
	if (cells.length > 1 && cells[0] === '') cells.shift();
	if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
	return cells;
}

/**
 * Pads a short row with empty cells and drops a long row's overflow, so every
 * row has exactly `width` columns.
 *
 * GFM defines the delimiter row as fixing the table's column count: a data row
 * with fewer cells is filled out with empty ones, and any cell beyond that
 * count is discarded. Rendering rows at their own natural width instead
 * produced a ragged table wherever the source was not perfectly aligned —
 * visibly different from every other Markdown renderer.
 */
function fitRow(cells: string[], width: number): string[] {
	if (cells.length === width) return cells;
	if (cells.length > width) return cells.slice(0, width);
	return cells.concat(new Array(width - cells.length).fill(''));
}

export interface TableModel {
	rows: string[][];
	headerRowCount: number;
	align: ColumnAlign[];
}

/** The cell grid and column alignment a `Table` node renders as. */
export function readTableModel(state: EditorState, tableNode: SyntaxNode): TableModel {
	const align = readColumnAlign(state, tableNode);
	const rows: string[][] = [];
	let headerRowCount = 0;
	for (const child of tableNode.getChildren('TableHeader')) {
		rows.push(readCells(state, child));
		headerRowCount = rows.length;
	}
	for (const child of tableNode.getChildren('TableRow')) {
		rows.push(readCells(state, child));
	}
	// The delimiter row is authoritative for the column count; fall back to the
	// header's own width if it somehow yielded nothing.
	const width = align.length || (rows.length ? rows[0].length : 0);
	return { rows: rows.map((cells) => fitRow(cells, width)), headerRowCount, align };
}

export function buildTableWidget(state: EditorState, node: SyntaxNodeRef): TableWidget {
	const { rows, headerRowCount, align } = readTableModel(state, node.node);
	return new TableWidget(rows, headerRowCount, align);
}

/**
 * Line numbers inside `item` that `blockDecorationsField` will replace with a
 * block widget — a table written directly under the item's own text.
 *
 * Those lines must not also carry a line decoration. CodeMirror silently drops
 * a block-replacing decoration whose range overlaps one, so a table nested in a
 * list item stayed raw pipe-separated text while the identical table at the top
 * level rendered normally. The list item's own text line keeps its decoration;
 * only the lines the widget covers are ceded.
 *
 * The conditions mirror `buildBlockDecorations` in blockDecorations.ts: if the
 * two disagree, either the widget is dropped again (line decorated, block
 * replaced) or list styling is lost for nothing (line skipped, no widget).
 * Mermaid fences are not checked — one nested in a list item never satisfies
 * `isLineAligned`, so it is never block-replaced there.
 */
export function blockReplacedLines(state: EditorState, item: SyntaxNode): Set<number> {
	const lines = new Set<number>();
	for (let child = item.firstChild; child; child = child.nextSibling) {
		if (child.name !== 'Table') continue;
		if (cursorTouchesRange(state, child.from, child.to)) continue;
		const range = alignedBlockRange(state, child.from, child.to);
		if (!range) continue;
		const first = state.doc.lineAt(range.from).number;
		const last = state.doc.lineAt(range.to).number;
		for (let n = first; n <= last; n++) lines.add(n);
	}
	return lines;
}

/** True when the list item owning this mark is a GFM task item ("- [ ] ..."). */
function listItemIsTask(state: EditorState, listMark: SyntaxNodeRef): boolean {
	const line = state.doc.lineAt(listMark.from);
	const after = state.sliceDoc(listMark.to, line.to);
	return /^\s*\[[ xX]\]/.test(after);
}

function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const { doc } = state;
	const decorations: Range<Decoration>[] = [];
	const seenReplace = new Set<string>();
	const seenLine = new Map<number, string>();
	const tree = syntaxTree(state);
	// blockDecorationsField renders the whole frontmatter block as its own
	// widget; skip it here too so this pass doesn't waste time computing
	// marks/line-classes for a range that block-level decoration will cover.
	// Only nodes *fully contained* in the block are skipped — fm.from is always
	// 0, so a naive "any overlap" test also matches the tree's own root node
	// (which spans the whole document) and would abort `tree.iterate` before it
	// ever descends into anything, silently dropping every decoration in the
	// entire document whenever frontmatter is present (see blockDecorations.ts).
	const fm = detectFrontmatter(state);

	const pushReplace = (from: number, to: number, deco: Decoration) => {
		const key = `${from}:${to}`;
		if (seenReplace.has(key)) return;
		seenReplace.add(key);
		decorations.push(deco.range(from, to));
	};

	// A line can only carry one line decoration, so merge class names per line and
	// emit them all at the end (each exactly once, at the line start).
	const addLineClass = (lineFrom: number, cls: string) => {
		const existing = seenLine.get(lineFrom);
		seenLine.set(lineFrom, existing ? `${existing} ${cls}` : cls);
	};
	// A callback returning '' marks a line as deliberately skipped — used where a
	// block widget will replace that line and a line decoration on it would make
	// CodeMirror drop the widget.
	const addLineRange = (from: number, to: number, cls: (lineNumber: number, first: boolean, last: boolean) => string) => {
		const firstLine = doc.lineAt(from).number;
		const lastLine = doc.lineAt(to).number;
		for (let n = firstLine; n <= lastLine; n++) {
			const value = cls(n, n === firstLine, n === lastLine);
			if (value) addLineClass(doc.line(n).from, value);
		}
	};

	for (const { from: rangeFrom, to: rangeTo } of view.visibleRanges) {
		tree.iterate({
			from: rangeFrom,
			to: rangeTo,
			enter: (node) => {
				if (fm && node.from >= fm.from && node.to <= fm.to) return false;
				const name = node.name;

				if (name in HEADING_LINE_CLASS) {
					addLineClass(doc.lineAt(node.from).from, HEADING_LINE_CLASS[name]);
					// Unconditionally plant a zero-size widget at the *end* of the heading
					// line, even while the cursor sits on it and the "#" marker is fully
					// visible. Otherwise, at the moment a heading line first mounts with
					// the cursor already on it (e.g. the very first line of the
					// document), its content is one plain, short, all-ASCII text node —
					// exactly what CodeMirror's height-oracle sampler looks for (see
					// HiddenMarkerWidget above) — and it gets poisoned before the user
					// ever moves the cursor away to trigger the HeaderMark-hiding path
					// below. Anchored at node.to (not node.from, where the HeaderMark's
					// own hidden-marker decoration starts) so the two never compete for
					// the same boundary position.
					decorations.push(Decoration.widget({ widget: hiddenMarker, side: 1 }).range(node.to));
					return; // descend so the HeaderMark ("#") gets hidden
				}

				switch (name) {
					case 'HeaderMark': {
						if (!cursorTouchesRange(state, node.from, node.to)) {
							const next = state.sliceDoc(node.to, node.to + 1);
							const to = next === ' ' ? node.to + 1 : node.to;
							// A plain replace (no widget) here: the heading line already
							// carries its own unconditional widget above, so it's never at
							// risk of being mistaken for a plain text line either way.
							pushReplace(node.from, to, Decoration.replace({}));
						}
						return;
					}
					case 'QuoteMark':
					case 'CodeMark':
					case 'CodeInfo': {
						if (!cursorTouchesRange(state, node.from, node.to)) {
							// Also swallow the single space after the marker so hidden markers
							// don't leave a dangling indent.
							const next = state.sliceDoc(node.to, node.to + 1);
							const to = next === ' ' ? node.to + 1 : node.to;
							pushReplace(node.from, to, hiddenMarkerDeco);
						}
						return;
					}
					case 'EmphasisMark':
					case 'StrikethroughMark': {
						if (!cursorTouchesRange(state, node.from, node.to)) {
							pushReplace(node.from, node.to, hiddenMarkerDeco);
						}
						return;
					}
					case 'StrongEmphasis':
						decorations.push(Decoration.mark({ tagName: 'strong', class: 'mlp-strong' }).range(node.from, node.to));
						return;
					case 'Emphasis':
						decorations.push(Decoration.mark({ tagName: 'em', class: 'mlp-em' }).range(node.from, node.to));
						return;
					case 'Strikethrough':
						decorations.push(Decoration.mark({ tagName: 'del', class: 'mlp-strikethrough' }).range(node.from, node.to));
						return;
					case 'InlineCode':
						decorations.push(Decoration.mark({ tagName: 'code', class: 'mlp-inline-code' }).range(node.from, node.to));
						return;
					case 'Paragraph': {
						// A list item's or blockquote's text is *also* wrapped in a
						// Paragraph node in the syntax tree (CommonMark always has one
						// there, "tight" list rendering just means the HTML omits the
						// `<p>` tag). Skip the standalone-paragraph classes when that's
						// the case: `ListItem`/`Blockquote` already add their own line
						// classes for this same line above, and merging both sets of
						// classes stacked a *second*, unrelated block's top/bottom
						// padding onto the line — e.g. the paragraph rule's
						// margin-bottom opening a gap under a blockquote whose own rule
						// specifies no bottom padding at all.
						const parentName = node.node.parent?.name;
						if (parentName === 'ListItem' || parentName === 'Blockquote') return;
						// Hand the paragraph's trailing gap (a theme's `p { margin-bottom }`,
						// which cssAdapter maps onto `-last` as padding-bottom) to the blank
						// line that separates this paragraph from what follows, rather than
						// leaving it on the paragraph's own last line.
						//
						// Both put the gap in the same place on screen — the separator line
						// and the gap simply swap order, so every block below keeps its exact
						// position. What changes is where the caret lands: pressing Enter at
						// the end of a paragraph leaves the cursor on a line the parser does
						// not consider part of the paragraph yet, so with the gap still above
						// it the caret sat a whole gap below the text it follows, then snapped
						// up the moment the first character was typed and the parser extended
						// the paragraph onto that line. Claiming the line up front makes the
						// layout the user lands on already the one typing produces — nothing
						// left to snap, and no dependence on where the cursor happens to be.
						const paragraphTo = blankLineAfter(state, node.to) ?? node.to;
						addLineRange(node.from, paragraphTo, (_n, first, last) => {
							let cls = 'mlp-line-paragraph';
							if (first) cls += ' mlp-line-paragraph-first';
							if (last) cls += ' mlp-line-paragraph-last';
							return cls;
						});
						return;
					}
					case 'ListItem': {
						// `-first`/`-last` must reflect this item's position within the
						// *enclosing list* (BulletList/OrderedList), not just within its
						// own (usually single-line) range — `addLineRange`'s own
						// first/last only sees the lines *this* ListItem spans, so every
						// item in the list would otherwise come out as both first and
						// last. That mattered once themes convert a `ul, ol { margin-bottom: … }`
						// rule (meant to apply once, after the whole list) onto
						// `-last`: with every item marked "last", every item picked up
						// that trailing margin, spacing a tight list out like a loose one.
						const parent = node.node.parent;
						const isFirstItem = !parent || parent.firstChild?.from === node.from;
						const isLastItem = !parent || parent.lastChild?.to === node.to;
						// Lines a nested table widget will replace get no line decoration,
						// or CodeMirror discards the widget and shows raw pipes instead.
						const replaced = blockReplacedLines(state, node.node);
						addLineRange(node.from, node.to, (n, first, last) => {
							if (replaced.has(n)) return '';
							let cls = 'mlp-line-list';
							if (first && isFirstItem) cls += ' mlp-line-list-first';
							if (last && isLastItem) cls += ' mlp-line-list-last';
							return cls;
						});
						return;
					}
					case 'Blockquote':
						addLineRange(node.from, node.to, (_n, first, last) => {
							let cls = 'mlp-line-quote';
							if (first) cls += ' mlp-line-quote-first';
							if (last) cls += ' mlp-line-quote-last';
							return cls;
						});
						return; // descend to hide the ">" marks
					case 'ListMark': {
						if (listItemIsTask(state, node)) {
							// Task items render a checkbox from the TaskMarker; drop the bullet.
							if (!cursorTouchesRange(state, node.from, node.to)) {
								const next = state.sliceDoc(node.to, node.to + 1);
								pushReplace(node.from, next === ' ' ? node.to + 1 : node.to, hiddenMarkerDeco);
							}
							return;
						}
						const markText = state.sliceDoc(node.from, node.to);
						if (/^[-*+]$/.test(markText)) {
							if (!cursorTouchesRange(state, node.from, node.to)) {
								pushReplace(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }));
							} else {
								decorations.push(Decoration.mark({ class: 'mlp-list-mark' }).range(node.from, node.to));
							}
						} else {
							// Ordered marker ("1.", "2)") — keep the number, just tint it.
							decorations.push(Decoration.mark({ class: 'mlp-list-mark' }).range(node.from, node.to));
						}
						return;
					}
					case 'TaskMarker': {
						if (!cursorTouchesRange(state, node.from, node.to)) {
							const checked = /[xX]/.test(state.sliceDoc(node.from, node.to));
							pushReplace(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }));
						}
						return;
					}
					case 'HorizontalRule':
						decorations.push(Decoration.mark({ class: 'mlp-hr' }).range(node.from, node.to));
						return;
					case 'FencedCode': {
						const infoNode = node.node.getChild('CodeInfo');
						const lang = infoNode ? state.sliceDoc(infoNode.from, infoNode.to).trim().toLowerCase() : '';
						const cursorAway = !cursorTouchesRange(state, node.from, node.to);
						if (lang === 'mermaid' && cursorAway && isLineAligned(state, node.from, node.to)) {
							// Rendered as a diagram by blockDecorationsField; skip entirely.
							return false;
						}
						const firstLineNum = doc.lineAt(node.from).number;
						const lastLineNum = doc.lineAt(node.to).number;
						// The opening/closing ``` fence lines have no visible text once their
						// marker is hidden (cursor away): leave them as plain, unstyled lines
						// (same as any blank line elsewhere) instead of styling them as part of
						// the code box, and move the rounded-corner/padding treatment onto the
						// first/last line that still has real content. This avoids doubling the
						// visible gap above/below the block, while keeping the fence line at its
						// normal height so it stays clickable/navigable for editing the language
						// tag. Skip this for an empty fence (no content lines at all) so there's
						// still a box to show.
						const hasContentLines = lastLineNum > firstLineNum + 1;
						const firstFenceHidden =
							hasContentLines && !cursorTouchesRange(state, doc.line(firstLineNum).from, doc.line(firstLineNum).to);
						const lastFenceHidden =
							hasContentLines && !cursorTouchesRange(state, doc.line(lastLineNum).from, doc.line(lastLineNum).to);
						const firstContentLine = firstFenceHidden ? firstLineNum + 1 : firstLineNum;
						const lastContentLine = lastFenceHidden ? lastLineNum - 1 : lastLineNum;
						addLineRange(node.from, node.to, (n) => {
							if (n === firstLineNum && firstFenceHidden) return '';
							if (n === lastLineNum && lastFenceHidden) return '';
							let cls = 'mlp-line-code';
							if (n === firstContentLine) cls += ' mlp-line-code-first';
							if (n === lastContentLine) cls += ' mlp-line-code-last';
							return cls;
						});
						return; // descend to hide the ``` fence marks
					}
					case 'Link': {
						const marks = node.node.getChildren('LinkMark');
						if (marks.length < 2) return;
						const labelFrom = marks[0].to;
						const labelTo = marks[1].from;
						const urlNode = node.node.getChild('URL');
						const href = urlNode ? state.sliceDoc(urlNode.from, urlNode.to) : '';
						decorations.push(
							Decoration.mark({ tagName: 'a', class: 'mlp-link', attributes: { 'data-href': href } }).range(labelFrom, labelTo),
						);
						if (!cursorTouchesRange(state, node.from, node.to)) {
							if (labelFrom > node.from) pushReplace(node.from, labelFrom, hiddenMarkerDeco);
							if (node.to > labelTo) pushReplace(labelTo, node.to, hiddenMarkerDeco);
						}
						return false;
					}
					case 'Image': {
						const marks = node.node.getChildren('LinkMark');
						if (marks.length < 2) return;
						const altFrom = marks[0].to;
						const altTo = marks[1].from;
						const urlNode = node.node.getChild('URL');
						const src = urlNode ? state.sliceDoc(urlNode.from, urlNode.to) : '';
						const alt = state.sliceDoc(altFrom, altTo);
						if (!cursorTouchesRange(state, node.from, node.to)) {
							pushReplace(node.from, node.to, Decoration.replace({ widget: new ImageWidget(src, alt) }));
						}
						return false;
					}
					case 'Table': {
						if (!cursorTouchesRange(state, node.from, node.to) && alignedBlockRange(state, node.from, node.to)) {
							// Rendered as a rich table by blockDecorationsField. Block
							// decorations may not be supplied from a view plugin, so emit
							// nothing here and let the state field replace this range.
							return false;
						}
						decorations.push(Decoration.mark({ class: 'mlp-table-raw' }).range(node.from, node.to));
						return;
					}
				}
			},
		});
	}

	for (const [lineFrom, cls] of seenLine) {
		decorations.push(Decoration.line({ class: cls }).range(lineFrom));
	}

	return Decoration.set(decorations, true);
}

export const livePreviewPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildDecorations(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged || update.selectionSet) {
				this.decorations = buildDecorations(update.view);
			}
		}
	},
	{ decorations: (v) => v.decorations },
);

export function createLinkClickHandler(onOpen: (href: string) => void) {
	return EditorView.domEventHandlers({
		mousedown(event) {
			if (!(event.ctrlKey || event.metaKey)) return false;
			const target = event.target as HTMLElement | null;
			const linkEl = target?.closest('.mlp-link') as HTMLElement | null;
			const href = linkEl?.getAttribute('data-href');
			if (href) {
				event.preventDefault();
				onOpen(href);
				return true;
			}
			return false;
		},
	});
}
