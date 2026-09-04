import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { Range, EditorState } from '@codemirror/state';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { cursorTouchesRange, blockCursorTouchesRange, noteRevealed } from './cmUtils';
import { isDiagramLang } from './diagramLang';
import { isDrawioPath } from './drawioFileClient';
import { DrawioFileWidget } from './drawioWidget';
import { wrapBlockWidget } from './blockWidgetWrap';
import { detectFrontmatter } from './frontmatterWidget';
import { renderInlineInto, type CellInlineHooks } from './tableCellInline';
import { createCodeModeButton, createCopyCodeButton } from './codeModeButton';
import { insertRow, insertColumn, renderTableMarkdown, type TableEditModel } from './tableEdit';
import { parseFenceInfo } from '../quarto/fence';
import { recordDecorationRebuild } from './debug';

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

/**
 * The stock Markdown parser represents a footnote-looking reference such as
 * `[^15][^16]` as one Link node: the first reference supplies the two
 * LinkMark children and the second one becomes a LinkLabel child. That shape
 * is not a normal Markdown link, and treating it as one would hide the second
 * reference when the cursor leaves the range. Keep the source visible until a
 * dedicated footnote renderer exists, so no Quarto/Pandoc syntax is lost.
 */
export function isFootnoteLikeReference(source: string): boolean {
	return /^(?:\[\^[^\]\r\n]+\])+$/.test(source);
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

/**
 * Floats a copy button over a fenced code block's top-right corner.
 *
 * Attached as a zero-width widget at the start of the block's first content
 * line, so it rides along with that line — no separate positioning root is
 * needed, and unlike the rendered blocks a code block is plain editor lines
 * that cannot host one anyway. `estimatedHeight: 0` keeps it out of
 * CodeMirror's height accounting, since it takes no space in the flow.
 */
class CopyCodeWidget extends WidgetType {
	constructor(
		private readonly from: number,
		private readonly to: number,
	) {
		super();
	}
	eq(other: CopyCodeWidget): boolean {
		return other.from === this.from && other.to === this.to;
	}
	toDOM(view: EditorView): HTMLElement {
		const host = document.createElement('span');
		host.className = 'mlp-copy-code-host';
		// Code-mode first, so the button order matches every other block: the
		// `</>` control sits leftmost in the group.
		//
		// A code block already shows its text, so what this reveals is the part
		// that is hidden — the ``` fence lines, with the language tag on them.
		// Editing those is how the language is changed or the block is unwrapped,
		// and there is otherwise no way to reach them by mouse: clicking a content
		// line places the caret without bringing the fences back.
		host.appendChild(
			createCodeModeButton(view, {
				anchor: host,
				// The opening ``` line, not the first line of code. Each fence hides
				// itself based on whether the caret is on *that* line (see the
				// `FencedCode` case in buildDecorations), so parking inside the body
				// leaves both fences blank and nothing appears to happen. Landing on
				// the opening fence puts the caret on the language tag, which is the
				// thing this button exists to let you edit.
				caretPos: () => {
					const doc = view.state.doc;
					const bodyLine = doc.lineAt(Math.min(this.from, doc.length));
					if (bodyLine.number <= 1) return bodyLine.from;
					const fence = doc.line(bodyLine.number - 1);
					return fence.to;
				},
			}),
		);
		// Read the text at click time: the block's content can change after the
		// widget is built, and the offsets are re-derived on every rebuild.
		host.appendChild(
			createCopyCodeButton(() => view.state.sliceDoc(Math.min(this.from, view.state.doc.length), Math.min(this.to, view.state.doc.length))),
		);
		return host;
	}
	get estimatedHeight(): number {
		return 0;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

export type ColumnAlign = 'left' | 'center' | 'right' | null;

/**
 * Builds the `<table>` for a parsed table model. Split out of `TableWidget` so
 * the rendered markup can be asserted on directly, without an `EditorView`.
 *
 * Each cell carries its grid position and, when it maps to real source, that
 * range — as data attributes. `TableWidget` reads them back on edit to know
 * which span of the document a cell's new text replaces.
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
			cell.className = 'mlp-table-cell';
			cell.dataset.mlpRow = String(rowIndex);
			cell.dataset.mlpCol = String(columnIndex);
			const span = model.cellRanges[rowIndex]?.[columnIndex];
			if (span) {
				cell.dataset.mlpFrom = String(span.from);
				cell.dataset.mlpTo = String(span.to);
				// The Markdown source, kept verbatim: editing shows this rather than
				// the rendered text, so `**bold**` stays editable as `**bold**`
				// instead of collapsing to `bold` and losing its markup on save.
				cell.dataset.mlpSrc = span.text;
			}
			renderInlineInto(cell, cellText, hooks);
			tr.appendChild(cell);
		});
		table.appendChild(tr);
	});
	return table;
}

/** The `data-mlp-*` bookkeeping `renderTableElement` puts on a cell. */
interface CellRef {
	row: number;
	col: number;
	from: number;
	to: number;
	source: string;
}

function readCellRef(cell: HTMLElement): CellRef | null {
	const { mlpRow, mlpCol, mlpFrom, mlpTo, mlpSrc } = cell.dataset;
	if (mlpRow === undefined || mlpCol === undefined || mlpFrom === undefined || mlpTo === undefined) return null;
	return {
		row: Number(mlpRow),
		col: Number(mlpCol),
		from: Number(mlpFrom),
		to: Number(mlpTo),
		source: mlpSrc ?? '',
	};
}

/**
 * A cell's edited text, normalised so writing it back cannot break the table.
 *
 * A newline would split the row into two lines and a raw `|` would invent a
 * column boundary, so both are neutralised: newlines collapse to spaces, and
 * pipes are backslash-escaped, which is how GFM spells a literal pipe inside a
 * cell.
 */
export function sanitizeCellInput(text: string): string {
	return text
		.replace(/\r?\n/g, ' ')
		.replace(/(^|[^\\])\|/g, '$1\\|')
		.trim();
}

/**
 * Rendered table with directly editable cells, in the style of Obsidian's
 * table editor.
 *
 * Clicking a cell puts the caret in that cell alone; the table stays rendered
 * rather than reverting to its pipe-delimited source, and only the edited cell
 * is written back (over the exact range `renderTableElement` recorded for it).
 * That keeps the rest of the row's text, padding and pipes byte-identical, so
 * an edit can neither reflow the source nor corrupt the table's structure.
 */
class TableWidget extends WidgetType {
	constructor(
		private readonly rows: string[][],
		private readonly headerRowCount: number,
		private readonly align: ColumnAlign[],
		private readonly cellRanges: (CellSpan | null)[][],
		private readonly tableFrom: number,
		private readonly tableTo: number,
		private readonly indent: string,
	) {
		super();
	}
	eq(other: TableWidget): boolean {
		return (
			JSON.stringify(other.rows) === JSON.stringify(this.rows) &&
			other.headerRowCount === this.headerRowCount &&
			JSON.stringify(other.align) === JSON.stringify(this.align) &&
			JSON.stringify(other.cellRanges) === JSON.stringify(this.cellRanges) &&
			other.tableFrom === this.tableFrom &&
			other.tableTo === this.tableTo &&
			other.indent === this.indent
		);
	}
	toDOM(view: EditorView): HTMLElement {
		const table = renderTableElement(
			{
				rows: this.rows,
				headerRowCount: this.headerRowCount,
				align: this.align,
				cellRanges: this.cellRanges,
				tableFrom: this.tableFrom,
				tableTo: this.tableTo,
				indent: this.indent,
			},
			cellInlineHooks,
		);
		// Positioning root for the code-mode button, which floats over the table's
		// top-right corner. The button can't hang off `.mlp-block` (the outer
		// spacing wrapper) because that box is what CodeMirror measures.
		const wrap = document.createElement('div');
		wrap.className = 'mlp-table-wrap';
		// The button is a normal element *before* the table, not an overlay on top
		// of it: floated over the corner it was easy to miss, and it had to be kept
		// clear of the header cell's own text. In the flow it sits in its own strip
		// above the table, where it reads as a control belonging to the table, and
		// the height it occupies is part of the box CodeMirror measures.
		const toolbar = document.createElement('div');
		toolbar.className = 'mlp-table-toolbar';
		wrap.appendChild(toolbar);
		wrap.appendChild(table);

		// The cell currently being edited, if any. Editing is entered lazily on
		// click rather than by making every cell permanently `contenteditable`,
		// so a cell shows its *rendered* form until the user actually goes to
		// change it, and its raw Markdown only while being edited.
		let editing: HTMLElement | null = null;
		// The cell most recently clicked or tabbed to, remembered after editing
		// ends so the code-mode button can put the caret back where the user was.
		let lastCell: HTMLElement | null = null;

		// Bound to the cell being edited, not to the table. A Tab that moves to the
		// next cell commits first, which rebuilds this widget — the table element
		// these listeners live on is replaced, so a handler on it never sees the
		// keys typed into the new cell, and Enter/Escape/Tab stopped working after
		// the first move. `beginEditing` attaches this to whichever cell is live.
		function onCellKeydown(event: KeyboardEvent): void {
			if (!editing) return;
			const ref = readCellRef(editing);
			if (!ref) return;
			if (event.key === 'Tab') {
				event.preventDefault();
				const current = editing;
				if (!moveFocus(ref, event.shiftKey ? -1 : 1)) commit(current);
				return;
			}
			if (event.key === 'Enter') {
				// A newline cannot live inside a cell, so Enter means "done".
				event.preventDefault();
				commit(editing);
				view.focus();
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				// Restoring the original text makes `commit` see no change, so the
				// edit is discarded rather than written back.
				editing.textContent = ref.source;
				commit(editing);
				view.focus();
			}
		}

		/**
		 * Writes a cell's edited text back to its own span of the document.
		 *
		 * Returns where that cell's text now ends, so a caller that wants to put
		 * the caret there doesn't have to re-derive it through the edit's own
		 * change in length. Null when nothing was written.
		 */
		const commit = (cell: HTMLElement): number | null => {
			// Write-back happens exactly once per cell. Committing re-renders the
			// table, and the DOM swap that follows fires `focusout` on the old
			// element — whose listener belongs to the *previous* widget instance and
			// so has its own `editing`, making an instance-level check useless. The
			// spent mark lives on the element itself, which is the thing both paths
			// share: without it the typed text was written twice ("oneXY" became
			// "oneXYXY") on Enter, on Tab, and on a structural edit.
			if (cell.dataset.mlpCommitted === '1') return null;
			cell.dataset.mlpCommitted = '1';
			cell.removeEventListener('keydown', onCellKeydown);
			const ref = readCellRef(cell);
			cell.contentEditable = 'false';
			cell.classList.remove('mlp-table-cell-editing');
			if (editing === cell) editing = null;
			// Let the columns size to content again. Tabbing on to another cell
			// re-freezes before anything is re-rendered (`beginEditing` calls
			// `freezeColumnWidths` first), so the table never visibly relaxes
			// between two cells — only when editing genuinely stops.
			thawColumnWidths();
			if (!ref) return null;
			const next = sanitizeCellInput(cell.textContent ?? '');
			if (next === ref.source) {
				// Unchanged: re-render in place. Skipping the dispatch avoids pushing
				// a no-op onto the undo history, but the DOM currently holds the raw
				// source text, so it still has to be restored.
				cell.textContent = '';
				renderInlineInto(cell, ref.source, cellInlineHooks);
				return ref.to;
			}
			// The span was read from the document as it stood when this widget was
			// built. Anything that changed the document since (an edit in another
			// cell, an undo, a sync from disk) invalidates it, and writing through a
			// stale range would overwrite unrelated text. Verifying the range still
			// holds the text it was read from is what makes that safe.
			if (ref.to > view.state.doc.length) return null;
			if (view.state.sliceDoc(ref.from, ref.to) !== ref.source) return null;
			// The caret must end up on a line *outside* the table. Any position on a
			// table line makes `cursorTouchesRange` true, which drops the rendered
			// widget for raw pipe text — the very mode switch this editor exists to
			// avoid, and it would fire the instant the edit was saved.
			const changes = { from: ref.from, to: ref.to, insert: next };
			const anchor = caretPastTable(view.state, ref.from, next.length - (ref.to - ref.from));
			view.dispatch(anchor === null ? { changes } : { changes, selection: { anchor } });
			// The replacement's own length is what the cell now ends at.
			return ref.from + next.length;
		};

		/**
		 * Pins the table's column widths to whatever they are right now.
		 *
		 * A table sizes its columns from their content, and a cell being edited
		 * swaps its rendered text for the Markdown source behind it — `t` becomes
		 * `**[t](https://example.com)**`. Left alone the column jumps to fit that,
		 * dragging every other column with it, so clicking a cell makes the whole
		 * table lurch. Measuring the columns first and writing those widths back as
		 * explicit `width` values, together with `table-layout: fixed` (which sizes
		 * columns from those values instead of from content), holds the layout
		 * still for as long as the edit lasts.
		 *
		 * Widths are read in one pass before any is written: setting a width
		 * changes the layout, so interleaving reads and writes would measure
		 * columns that had already been moved by the previous write.
		 */
		const freezeColumnWidths = (): void => {
			if (table.style.tableLayout === 'fixed') return; // already frozen
			const firstRow = (table as HTMLTableElement).rows?.[0];
			if (!firstRow) return;
			const cells = Array.from(firstRow.cells) as HTMLElement[];
			const widths = cells.map((c) => c.getBoundingClientRect().width);
			// A table that has not been laid out yet (zero-width) has nothing
			// meaningful to pin, and writing zeros would collapse it.
			if (!widths.every((w) => w > 0)) return;
			// Widths are pinned as *percentages*, not pixels. A pixel width is a
			// snapshot of one moment: if the editor gets narrower mid-edit — a
			// sidebar opens, the window is resized, the view is split — a pinned
			// pixel width keeps the table at its old size and it hangs past the text
			// column. (`max-width: 100%` does not save it either: under
			// `table-layout: fixed` the per-column pixel widths win, and the table
			// overflows anyway.) Percentages hold the *proportions* that stop the
			// lurch while still letting the table track its container's width.
			const total = widths.reduce((sum, w) => sum + w, 0);
			if (total <= 0) return;
			cells.forEach((c, i) => {
				// `getBoundingClientRect` measures the border box, but `width`
				// defaults to sizing the *content* box — without this the padding and
				// borders would be added on top of the measurement and every column
				// would come back wider than it was.
				c.style.boxSizing = 'border-box';
				c.style.width = (widths[i] / total) * 100 + '%';
			});
			table.style.boxSizing = 'border-box';
			table.style.tableLayout = 'fixed';
		};

		/** Releases the pinned widths, letting the table size to content again. */
		const thawColumnWidths = (): void => {
			if (table.style.tableLayout !== 'fixed') return;
			table.style.tableLayout = '';
			table.style.boxSizing = '';
			const firstRow = (table as HTMLTableElement).rows?.[0];
			if (!firstRow) return;
			for (const cell of Array.from(firstRow.cells) as HTMLElement[]) {
				cell.style.width = '';
				cell.style.boxSizing = '';
			}
		};

		/** Swaps a cell to its raw Markdown and puts the caret in it. */
		const beginEditing = (cell: HTMLElement, caret: 'all' | 'end'): void => {
			if (editing === cell) return;
			if (editing) commit(editing);
			const ref = readCellRef(cell);
			if (!ref) return; // padding cell invented by fitRow; no source to edit
			// Must run before the cell's text is swapped below, while the columns
			// still hold their rendered widths.
			freezeColumnWidths();
			// Park the document caret on this cell's own line. It is not used for
			// typing — the contenteditable cell below handles that — but it has to
			// go *somewhere*, and wherever it was left is a line whose inline markup
			// then shows its source: clicking a table cell would reveal the `#` on a
			// heading elsewhere in the document. The table's own line is safe,
			// because this widget is exempt from that reveal while a cell is being
			// edited (see `blockCursorTouchesRange`).
			if (ref.from <= view.state.doc.length) {
				view.dispatch({ selection: { anchor: ref.from } });
			}
			editing = cell;
			lastCell = cell;
			// Clear the spent mark: this cell is being edited afresh, and its next
			// commit must go through even if an earlier one already did. Tabbing
			// back onto a cell edited a moment ago otherwise silently discarded the
			// new text.
			delete cell.dataset.mlpCommitted;
			cell.addEventListener('keydown', onCellKeydown);
			cell.classList.add('mlp-table-cell-editing');
			cell.contentEditable = 'true';
			cell.textContent = ref.source;
			cell.focus();
			const selection = window.getSelection?.();
			if (!selection) return;
			const range = document.createRange();
			range.selectNodeContents(cell);
			if (caret === 'end') range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
		};

		const cellAt = (row: number, col: number): HTMLElement | null =>
			table.querySelector('[data-mlp-row="' + row + '"][data-mlp-col="' + col + '"]');

		/** Moves editing `delta` cells along in reading order. */
		const moveFocus = (ref: CellRef, delta: number): boolean => {
			const width = this.align.length || this.rows[0]?.length || 0;
			if (!width) return false;
			const index = ref.row * width + ref.col + delta;
			if (index < 0 || index >= this.rows.length * width) return false;
			const row = Math.floor(index / width);
			const col = index % width;
			if (!cellAt(row, col)) return false;

			// Saving the cell being left rewrites the document, and CodeMirror
			// answers that by rebuilding this widget — every cell element, including
			// the one Tab is moving to, is replaced. Holding a reference across the
			// commit therefore landed the edit on a node no longer in the document:
			// the caret went nowhere and whatever was typed next was lost. The
			// destination is identified by its grid position instead, and looked up
			// again afterwards, in the table that is on screen by then.
			if (editing) commit(editing);
			const finish = (): void => {
				// Scoped to *this* table's replacement, not the first one in the
				// document: a file with several tables would otherwise start editing
				// the wrong one. `domAtPos` resolves the widget now occupying this
				// table's position back to its element.
				const host = view.domAtPos(Math.min(this.tableFrom, view.state.doc.length)).node as HTMLElement | null;
				const scope = (host?.nodeType === 1 ? host : host?.parentElement)?.closest('.mlp-table-wrap');
				const live = (scope ?? document).querySelector<HTMLElement>(
					`.mlp-table-cell[data-mlp-row="${row}"][data-mlp-col="${col}"]`,
				);
				// Tab selects the whole cell it lands on, the way a spreadsheet does,
				// so typing straight away replaces the old value.
				if (live) beginEditing(live, 'all');
			};
			// The rebuild lands in a measure/update cycle, so the new element does not
			// exist yet; `requestAnimationFrame` runs after it has been mounted.
			if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
			else finish();
			return true;
		};


		toolbar.appendChild(
			createCodeModeButton(view, {
				anchor: table,
				// Save any half-finished cell edit first; `commit` reports where that
				// cell's text ended up, which already accounts for the edit's own change
				// in length.
				beforeShow: () => (editing ? commit(editing) : null),
				// Otherwise open the source at the cell the user last touched, so it
				// lands where they were looking rather than at the table's start.
				caretPos: () => {
					const target = editing ?? lastCell;
					return (target ? readCellRef(target)?.to : undefined) ?? view.posAtDOM(table);
				},
			}),
		);

		// Cell interaction is driven from `mousedown`, not `click`.
		//
		// The editor is editable, so CodeMirror installs its own `mousedown`
		// handler on the content DOM and sets the selection from it — before any
		// `click` fires. (`ignoreEvent` does not prevent this: it only stops
		// CodeMirror reading the event as an interaction with the *widget's*
		// document position.) So while a click handler was in charge, every press
		// on the table had already moved the caret into it by the time that handler
		// ran, and a caret on a table line makes `cursorTouchesRange` withhold this
		// widget — the table flipped to raw pipe text. It usually looked fine only
		// because `beginEditing` then re-rendered fast enough to hide it; whenever
		// the click handler bailed out early instead, the revert was what remained.
		// Taking the press itself, and stopping it there, removes the race rather
		// than trying to out-run it.
		//
		// What still has to be distinguished is a click from a drag-select, and that
		// is only knowable at release — so the press records its position and the
		// decision is made on `mouseup`.
		let pressedCell: HTMLElement | null = null;
		let pressX = 0;
		let pressY = 0;
		const DRAG_SLOP_PX = 4;

		table.addEventListener('mousedown', (event) => {
			pressedCell = null;
			// Ctrl/Cmd-click opens a link (createLinkClickHandler) and the secondary
			// button opens a context menu; neither is ours to take.
			if (event.ctrlKey || event.metaKey || event.button !== 0) return;
			const cell = cellFromPoint(event, table);
			if (!cell) return;
			pressedCell = cell;
			pressX = event.clientX;
			pressY = event.clientY;
			if (event.detail > 1) {
				// Second and later presses of a rapid sequence: the browser would
				// select a word or paragraph of the *rendered* text, which is about to
				// be replaced by the cell's raw Markdown anyway. Suppressing it keeps
				// repeated clicking from looking like a drag-select.
				event.preventDefault();
			}
			// Keep the press away from CodeMirror's own handler, which would otherwise
			// put the caret in the table and unrender it.
			event.stopPropagation();
		});

		table.addEventListener('mouseup', (event) => {
			const cell = pressedCell;
			pressedCell = null;
			if (!cell) return;
			event.stopPropagation();
			// Released far from where it went down: that was a drag, and the text it
			// selected is a copy gesture. Leave the selection alone.
			if (Math.hypot(event.clientX - pressX, event.clientY - pressY) > DRAG_SLOP_PX) return;
			// A single press that nonetheless left text selected is the tail of a
			// drag that ended near its start; also a copy gesture.
			if (event.detail <= 1 && hasTextSelectionWithin(table)) return;
			event.preventDefault();
			if (event.detail > 1) window.getSelection?.()?.removeAllRanges();
			beginEditing(cell, 'end');
		});

		// The click that follows a handled press has nothing left to do, but it must
		// not reach CodeMirror either.
		table.addEventListener('click', (event) => {
			if (event.ctrlKey || event.metaKey) return;
			if (cellFromPoint(event, table)) {
				event.preventDefault();
				event.stopPropagation();
			}
		});


		// Clicking or tabbing away saves, mirroring a spreadsheet. Moving to
		// another cell is handled by `beginEditing` before this fires.
		table.addEventListener('focusout', (event) => {
			const cell = event.target as HTMLElement | null;
			if (!cell || cell !== editing) return;
			const next = (event as FocusEvent).relatedTarget as Node | null;
			if (next && cell.contains(next)) return;
			commit(cell);
		});

		/**
		 * Reads this table back out of the document as it stands right now.
		 *
		 * Returns null when the range no longer holds a table — the document was
		 * edited out from under this widget, and rewriting through a stale range
		 * would overwrite unrelated text.
		 */
		const currentTableModel = (): { model: TableEditModel; from: number; to: number } | null => {
			const state = view.state;
			const pos = Math.min(this.tableFrom, state.doc.length);
			let found: SyntaxNode | null = null;
			syntaxTree(state).iterate({
				from: pos,
				to: Math.min(this.tableTo, state.doc.length),
				enter(node) {
					if (!found && node.name === 'Table') found = node.node;
				},
			});
			if (!found) return null;
			const table = found as SyntaxNode;
			const read = readTableModel(state, table);
			return {
				model: {
					rows: read.rows,
					headerRowCount: read.headerRowCount,
					align: read.align,
					indent: read.indent,
				},
				from: read.tableFrom,
				to: read.tableTo,
			};
		};

		/**
		 * Rebuilds the whole table through `change` and replaces it in the
		 * document.
		 *
		 * Unlike a cell edit, which writes back one span, a structural change
		 * touches every line — a new column has to appear in the header, the
		 * delimiter row and every data row at once — so the table is re-rendered
		 * from its model and swapped in whole.
		 */
		const applyStructuralEdit = (change: (model: TableEditModel) => TableEditModel): void => {
			// Any half-finished cell edit is saved first, or it would be discarded by
			// the rewrite that follows. `commit` clears `editing` itself, so the
			// `focusout` this button's click also triggers finds nothing left to do
			// — without that, both paths committed and the typed text was written
			// twice ("oneXY" became "oneXYXY").
			if (editing) commit(editing);
			// Re-read the table from the document rather than using this widget's own
			// fields. Those describe the document as it stood when the widget was
			// built, and the `commit` above may just have changed it — rebuilding
			// from the stale copy wrote the old cell text back over the new, leaving
			// the row mangled. Re-reading also makes a widget outlive an edit from
			// anywhere else (another tab, an undo) safely.
			const current = currentTableModel();
			if (!current) return;
			const { model, from, to } = current;
			const next = change(model);
			const insert = renderTableMarkdown(next);
			if (view.state.sliceDoc(from, to) === insert) return;
			const doc = view.state.doc;
			// The caret must not land inside the rebuilt table: a caret on a table
			// line withholds the widget, so the table would show as raw pipe text
			// straight after the row was added. `from + insert.length` is its very
			// end — still on the last table line — so the line *after* it is the
			// nearest safe spot, and the end of the document if there is none.
			const nextLength = doc.length - (to - from) + insert.length;
			const endOfTable = from + insert.length;
			const anchor = Math.min(endOfTable + 1, nextLength);
			view.dispatch({ changes: { from, to, insert }, selection: { anchor } });
		};

		const makeAddButton = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'mlp-table-add-btn';
			button.textContent = label;
			button.title = title;
			button.setAttribute('aria-label', title);
			// The press must not reach the table underneath, or the cell below the
			// button starts editing before the click runs.
			button.addEventListener('mousedown', (event) => {
				event.preventDefault();
				event.stopPropagation();
			});
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				onClick();
			});
			return button;
		};

		// Row and column are added at the end, which is what a `+` on the table's
		// bottom and right edges reads as. Inserting elsewhere is a different
		// gesture (a handle on the row or column itself) and is not offered here.
		const addRowBtn = makeAddButton('+', '添加行', () =>
			applyStructuralEdit((m) => insertRow(m, m.rows.length)),
		);
		addRowBtn.classList.add('mlp-table-add-row');
		const addColBtn = makeAddButton('+', '添加列', () =>
			applyStructuralEdit((m) => insertColumn(m, m.align.length || m.rows[0]?.length || 0)),
		);
		addColBtn.classList.add('mlp-table-add-col');
		wrap.append(addRowBtn, addColBtn);

		return wrapBlockWidget(wrap);
	}
	ignoreEvent(): boolean {
		// Every event the rendered table handles itself — text selection, cell
		// clicks, and typing into a `contenteditable` cell — has to reach the DOM
		// rather than being read by CodeMirror as an interaction with the widget's
		// position in the document. Letting mousedown through in particular is what
		// allows a drag to select cell text for copying.
		return true;
	}
}

/**
 * A caret position just past the table containing `posInTable`, in the
 * *post-change* document (`lengthDelta` is how much the edit grew or shrank it).
 *
 * Returns null when the table runs to the end of the document and there is no
 * line after it to hold the caret; the caller then leaves the selection alone
 * rather than placing it somewhere that would unrender the table.
 */
export function caretPastTable(state: EditorState, posInTable: number, lengthDelta: number): number | null {
	const doc = state.doc;
	let line = doc.lineAt(Math.min(posInTable, doc.length));
	// Walk to the last line of the table. A table is a run of consecutive lines
	// that each contain a pipe; the first line without one ends it.
	while (line.number < doc.lines) {
		const next = doc.line(line.number + 1);
		if (!next.text.includes('|')) break;
		line = next;
	}
	if (line.number >= doc.lines) return null;
	return doc.line(line.number + 1).from + lengthDelta;
}

/**
 * The cell a click landed in, decided from the pointer's own coordinates.
 *
 * `event.target` is not reliable here. Under `border-collapse: collapse`
 * adjacent cells *share* one border, and a click on that shared line is
 * attributed to whichever cell the browser picks — often the one above. Clicking
 * the line just above a cell then began editing the cell above it instead, which
 * is exactly the row the user was trying to leave alone.
 *
 * Measuring the click against each cell's own box removes the ambiguity: a point
 * on the shared border belongs to the cell whose box contains it, and when both
 * do (the border's own thickness) the later one — the row being clicked into —
 * wins, since the scan keeps the last match.
 */
function cellFromPoint(event: MouseEvent, table: HTMLElement): HTMLElement | null {
	const direct = (event.target as HTMLElement | null)?.closest('.mlp-table-cell') as HTMLElement | null;
	const cells = Array.from(table.querySelectorAll('.mlp-table-cell')) as HTMLElement[];
	let found: HTMLElement | null = null;
	for (const cell of cells) {
		const box = cell.getBoundingClientRect();
		if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) {
			found = cell;
		}
	}
	// Fall back to the event's own target when the point matched nothing (a click
	// on the table's outer edge), so behaviour is never *worse* than before.
	const cell = found ?? direct;
	return cell && table.contains(cell) ? cell : null;
}

/**
 * Whether the user currently has text selected inside `root`.
 *
 * Used to tell a click apart from the end of a drag-select: after a real
 * selection the click event still fires, and treating it as a plain click would
 * replace the highlighted table with its Markdown source before the user could
 * copy it.
 */
function hasTextSelectionWithin(root: HTMLElement): boolean {
	const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
	const range = selection.getRangeAt(0);
	return root.contains(range.commonAncestorContainer);
}

// @lezer/markdown's table parser only emits a `TableCell` node for cells that
// contain non-whitespace content — an empty cell (e.g. the middle column of
// `| a | | c |`) produces no node at all. Reading cells via `getChildren`
// therefore silently drops empty cells and shifts every later column left.
// Splitting the row's raw text ourselves (mirroring the parser's own
// leading/trailing-pipe trimming) keeps empty cells in place.
/**
 * One cell as it sits in the document: its trimmed text, plus the exact source
 * range that text occupies.
 *
 * The range is what makes editing a rendered cell possible. Writing a new value
 * back as a change over just this span leaves every other cell's text, and the
 * row's pipes and padding, untouched, so an edit cannot corrupt the table's
 * structure or disturb columns the user did not touch.
 *
 * `from`/`to` bound the *trimmed* text, so the surrounding padding spaces
 * survive an edit and the source keeps whatever alignment the author had. An
 * empty cell has `from === to`, pointing at the insertion spot between its
 * pipes.
 */
export interface CellSpan {
	text: string;
	from: number;
	to: number;
}

/**
 * Splits a table row into its cells, keeping each cell's source range.
 *
 * Cell splitting has to be done by hand rather than through `getChildren`
 * because the parser emits no node for an empty cell (see the note above
 * `readCells`).
 */
export function readCellSpans(state: EditorState, rowNode: SyntaxNode): CellSpan[] {
	const text = state.sliceDoc(rowNode.from, rowNode.to);
	const segments: { raw: string; offset: number }[] = [];
	let cell = '';
	let cellStart = 0;
	let escaped = false;
	let index = 0;
	for (const ch of text) {
		if (ch === '|' && !escaped) {
			segments.push({ raw: cell, offset: cellStart });
			cell = '';
			index += ch.length;
			cellStart = index;
			escaped = false;
			continue;
		}
		cell += ch;
		escaped = !escaped && ch === '\\';
		index += ch.length;
	}
	segments.push({ raw: cell, offset: cellStart });
	// A leading/trailing pipe produces a bounding empty segment, not a column.
	if (segments.length > 1 && segments[0].raw.trim() === '') segments.shift();
	if (segments.length > 1 && segments[segments.length - 1].raw.trim() === '') segments.pop();
	return segments.map(({ raw, offset }) => {
		// Shift past the padding so the range bounds the trimmed text alone.
		const leading = raw.length - raw.trimStart().length;
		const trimmed = raw.trim();
		const from = rowNode.from + offset + leading;
		return { text: trimmed, from, to: from + trimmed.length };
	});
}

export function readCells(state: EditorState, rowNode: SyntaxNode): string[] {
	return readCellSpans(state, rowNode).map((cell) => cell.text);
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
function fitRow<T>(cells: T[], width: number, pad: T = '' as T): T[] {
	if (cells.length === width) return cells;
	if (cells.length > width) return cells.slice(0, width);
	return cells.concat(new Array(width - cells.length).fill(pad));
}

export interface TableModel {
	rows: string[][];
	headerRowCount: number;
	align: ColumnAlign[];
	/**
	 * Source range of every cell in `rows`, same shape and indexing.
	 *
	 * Carried alongside the text so an edit made in the rendered table can be
	 * written back to the one span it belongs to. Padding cells invented by
	 * `fitRow` for a ragged row have no source of their own; they are recorded
	 * as `null` and are not directly editable.
	 */
	cellRanges: (CellSpan | null)[][];
	/**
	 * The table's whole range in the document, and the indentation its lines
	 * carry (two spaces for a table nested under a list item, say).
	 *
	 * Cell editing does not need these — it writes one span at a time — but a
	 * structural edit does: adding a row or a column changes every line, so the
	 * table is rebuilt and this range is what the result replaces.
	 */
	tableFrom: number;
	tableTo: number;
	indent: string;
}

/** The cell grid and column alignment a `Table` node renders as. */
export function readTableModel(state: EditorState, tableNode: SyntaxNode): TableModel {
	const align = readColumnAlign(state, tableNode);
	const spanRows: CellSpan[][] = [];
	let headerRowCount = 0;
	for (const child of tableNode.getChildren('TableHeader')) {
		spanRows.push(readCellSpans(state, child));
		headerRowCount = spanRows.length;
	}
	for (const child of tableNode.getChildren('TableRow')) {
		spanRows.push(readCellSpans(state, child));
	}
	// The delimiter row is authoritative for the column count; fall back to the
	// header's own width if it somehow yielded nothing.
	const width = align.length || (spanRows.length ? spanRows[0].length : 0);
	// Whatever precedes the table on its first line is pure indentation — the
	// block decoration is only applied when that holds (see `alignedBlockRange`).
	const firstLine = state.doc.lineAt(tableNode.from);
	return {
		rows: spanRows.map((cells) => fitRow(cells.map((c) => c.text), width)),
		cellRanges: spanRows.map((cells) => fitRow<CellSpan | null>(cells, width, null)),
		headerRowCount,
		align,
		// Widened to the start of the line, the way `alignedBlockRange` widens the
		// decoration's own range. The parser's `from` sits *after* a nested table's
		// indentation, so replacing from there would leave the original indent in
		// front of the rebuilt first line while every other line carried the indent
		// this model reapplies — the first row ending up doubly indented.
		tableFrom: firstLine.from,
		tableTo: tableNode.to,
		indent: state.sliceDoc(firstLine.from, tableNode.from),
	};
}

export function buildTableWidget(state: EditorState, node: SyntaxNodeRef): TableWidget {
	const { rows, headerRowCount, align, cellRanges, tableFrom, tableTo, indent } = readTableModel(state, node.node);
	return new TableWidget(rows, headerRowCount, align, cellRanges, tableFrom, tableTo, indent);
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
 * Diagram fences (Mermaid, draw.io) are not checked — one nested in a list item
 * never satisfies `isLineAligned`, so it is never block-replaced there.
 */
export function blockReplacedLines(state: EditorState, item: SyntaxNode): Set<number> {
	const lines = new Set<number>();
	for (let child = item.firstChild; child; child = child.nextSibling) {
		if (child.name !== 'Table') continue;
		if (blockCursorTouchesRange(state, child.from, child.to)) continue;
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

export type DecorationRebuildReason = 'docChanged' | 'viewportChanged' | 'selectionSet' | 'syntaxTreeChanged';

/**
 * Keeps the live inline decoration pass in step with Lezer's asynchronous
 * background parser. The language package advances its StateField by dispatching
 * a transaction with no document, selection, or viewport change; comparing the
 * trees is the signal that the visible syntax nodes may now be available.
 */
export function decorationRebuildReason(update: ViewUpdate): DecorationRebuildReason | null {
	if (update.docChanged) return 'docChanged';
	if (update.viewportChanged) return 'viewportChanged';
	if (update.selectionSet) return 'selectionSet';
	if (syntaxTree(update.startState) !== syntaxTree(update.state)) return 'syntaxTreeChanged';
	return null;
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
						const info = parseFenceInfo(infoNode ? state.sliceDoc(infoNode.from, infoNode.to) : '');
						const lang = info.language ?? '';
						// Must use the same test blockDecorationsField uses to decide
						// whether the diagram renders — if the two disagree, either the
						// widget is dropped or the fence is styled as code underneath it.
						if (
							isDiagramLang(lang) !== null &&
							!blockCursorTouchesRange(state, node.from, node.to) &&
							isLineAligned(state, node.from, node.to)
						) {
							// Rendered as a diagram by blockDecorationsField; skip entirely.
							return false;
						}
						const cursorAway = !cursorTouchesRange(state, node.from, node.to);
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
						// Copy button, over the block's top-right corner. Selecting a code
						// block by hand sweeps up the hidden ``` fence lines and any
						// indentation the block is nested under, so a hand-made selection
						// needs tidying before it can be pasted. The button copies the
						// content lines exactly, with neither fence nor indentation.
						if (hasContentLines && cursorAway) {
							const codeFrom = doc.line(firstLineNum + 1).from;
							const codeTo = doc.line(lastLineNum - 1).to;
							decorations.push(
								Decoration.widget({ widget: new CopyCodeWidget(codeFrom, codeTo), side: -1 }).range(codeFrom),
							);
						}
						return; // descend to hide the ``` fence marks
					}
					case 'Link': {
						if (isFootnoteLikeReference(state.sliceDoc(node.from, node.to))) return;
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
							// A `.drawio` reference is XML, not an image format: an <img>
							// pointed at it renders nothing at all, so it goes to the
							// diagram widget (which reads the file through the host)
							// instead. `.drawio.svg`/`.drawio.png` deliberately do not —
							// those are real images that an <img> already shows correctly.
							const widget = isDrawioPath(src) ? new DrawioFileWidget(src, alt) : new ImageWidget(src, alt);
							pushReplace(node.from, node.to, Decoration.replace({ widget }));
						}
						return false;
					}
					case 'Table': {
						const tableRevealed = blockCursorTouchesRange(state, node.from, node.to);
						noteRevealed(node.from, node.to, tableRevealed);
						if (!tableRevealed && alignedBlockRange(state, node.from, node.to)) {
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
			const start = performance.now();
			this.decorations = buildDecorations(view);
			recordDecorationRebuild('initial', view, performance.now() - start);
		}

		update(update: ViewUpdate) {
			const reason = decorationRebuildReason(update);
			if (reason) {
				const start = performance.now();
				this.decorations = buildDecorations(update.view);
				recordDecorationRebuild(reason, update.view, performance.now() - start);
			}
		}
	},
	{ decorations: (v) => v.decorations },
);

/**
 * Opens a rendered link when it is clicked.
 *
 * A plain click follows the link, which is what a link that *looks* like a
 * link is expected to do — it used to require Ctrl/Cmd, and a plain click fell
 * through to CodeMirror instead, putting the caret in the text and unrendering
 * the link into its `[label](url)` source. Ctrl/Cmd-click keeps working, so
 * the habit from the old behaviour still does the right thing.
 *
 * Editing a link's own text is still possible: click just outside it, or use
 * the keyboard. That is the same trade every rendered block makes here.
 */
export function createLinkClickHandler(onOpen: (href: string) => void) {
	const handle = (event: MouseEvent): boolean => {
		// Only the primary button; a right-click belongs to the context menu.
		if (event.button !== 0) return false;
		const target = event.target as HTMLElement | null;
		const linkEl = target?.closest('.mlp-link') as HTMLElement | null;
		const href = linkEl?.getAttribute('data-href');
		if (!href) return false;
		event.preventDefault();
		onOpen(href);
		return true;
	};
	return EditorView.domEventHandlers({
		// Taken on the press, before CodeMirror's own mousedown handler can move
		// the caret into the link and reveal its source.
		mousedown: handle,
		// The click that follows is swallowed too, so nothing acts on it twice.
		click: (event) => {
			const target = event.target as HTMLElement | null;
			if (!target?.closest('.mlp-link')) return false;
			event.preventDefault();
			return true;
		},
	});
}
