import { EditorSelection, StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';
import { EditorView, WidgetType, type Command, type MouseSelectionStyle, type ViewUpdate } from '@codemirror/view';
import { findFenceSpans, scanSourceLines } from '../quarto/fence';
import { pointerGestureIsActive, selectionTouchesInlineRangeForDecoration } from './cmUtils';
import { beginPrimaryPointerGesture, isPointerClick, type PointerGestureStart } from './pointerGesture';

export interface FootnoteReference {
	id: string;
	from: number;
	to: number;
	ordinal: number;
}

export interface FootnoteDefinition {
	id: string;
	markerFrom: number;
	markerTo: number;
	contentFrom: number;
	contentTo: number;
}

export interface FootnoteIndex {
	references: FootnoteReference[];
	definitions: Map<string, FootnoteDefinition>;
	invalidIds: Set<string>;
}

interface Span {
	from: number;
	to: number;
}

function isInside(position: number, span: Span): boolean {
	return position >= span.from && position < span.to;
}

function isProtected(position: number, spans: Span[]): boolean {
	return spans.some((span) => isInside(position, span));
}

function addInlineCodeSpans(text: string, spans: Span[]): void {
	for (const line of scanSourceLines(text)) {
		const code = line.text;
		const tokens = [...code.matchAll(/`+/g)];
		for (let i = 0; i < tokens.length; i++) {
			const open = tokens[i];
			const run = open[0];
			const close = tokens.find((candidate, index) => index > i && candidate[0] === run);
			if (!close || close.index === undefined || open.index === undefined) continue;
			spans.push({ from: line.from + open.index, to: line.from + close.index + run.length });
			i = tokens.indexOf(close);
		}
	}
}

function frontmatterSpan(text: string): Span | null {
	const lines = scanSourceLines(text);
	if (lines.length === 0 || lines[0].text.trim() !== '---') return null;
	for (let i = 1; i < lines.length; i++) {
		if (/^\s*(?:---|\.\.\.)\s*$/.test(lines[i].text)) return { from: 0, to: lines[i].fullTo };
	}
	return { from: 0, to: text.length };
}

function hasOddBackslashes(text: string, from: number): boolean {
	let count = 0;
	for (let i = from - 1; i >= 0 && text[i] === '\\'; i--) count++;
	return count % 2 === 1;
}

function definitionForLine(line: { from: number; to: number; text: string }): FootnoteDefinition | null {
	const match = /^( {0,3})\[\^([^\]\r\n]+)\]:/.exec(line.text);
	if (!match) return null;
	const markerFrom = line.from + match[1].length;
	const markerTo = markerFrom + match[0].length - match[1].length;
	return {
		id: match[2],
		markerFrom,
		markerTo,
		contentFrom: markerTo + (line.text[markerTo - line.from] === ' ' ? 1 : 0),
		contentTo: line.to,
	};
}

/**
 * Scans the complete source because definitions can be outside CodeMirror's
 * current viewport. Decorations remain viewport-limited in livePreviewPlugin.
 * Invalid references intentionally stay raw, which is the safest fallback for
 * malformed Quarto/Pandoc input and preserves every source character.
 */
export function scanFootnotes(text: string | Text): FootnoteIndex {
	const source = typeof text === 'string' ? text : text.toString();
	const protectedSpans: Span[] = [];
	const fm = frontmatterSpan(source);
	if (fm) protectedSpans.push(fm);
	for (const span of findFenceSpans(source)) protectedSpans.push(span);
	addInlineCodeSpans(source, protectedSpans);

	const definitionsById = new Map<string, FootnoteDefinition[]>();
	const lines = scanSourceLines(source);
	for (const line of lines) {
		if (isProtected(line.from, protectedSpans)) continue;
		const definition = definitionForLine(line);
		if (!definition) continue;
		const entries = definitionsById.get(definition.id) ?? [];
		entries.push(definition);
		definitionsById.set(definition.id, entries);
	}

	const definitions = new Map<string, FootnoteDefinition>();
	const invalidIds = new Set<string>();
	for (const [id, entries] of definitionsById) {
		if (entries.length === 1) definitions.set(id, entries[0]);
		else invalidIds.add(id);
	}

	const references: FootnoteReference[] = [];
	const seenOrdinals = new Map<string, number>();
	for (const line of lines) {
		for (const match of line.text.matchAll(/\[\^([^\]\r\n]+)\]/g)) {
			if (match.index === undefined) continue;
			const from = line.from + match.index;
			const to = from + match[0].length;
			if (isProtected(from, protectedSpans) || hasOddBackslashes(source, from)) continue;
			// The `[^id]` prefix of a definition marker is a definition, not a
			// reference. References in the definition's content remain eligible.
			const definition = definitionsById.get(match[1])?.find((entry) => from >= entry.markerFrom && to <= entry.markerTo);
			if (definition) continue;
			if (!definitions.has(match[1])) continue;
			const ordinal = seenOrdinals.get(match[1]) ?? (seenOrdinals.size + 1);
			seenOrdinals.set(match[1], ordinal);
			references.push({ id: match[1], from, to, ordinal });
		}
	}

	return { references, definitions, invalidIds };
}

export const footnoteIndexField = StateField.define<FootnoteIndex>({
	create: (state) => scanFootnotes(state.doc),
	update(value, transaction) {
		return transaction.docChanged ? scanFootnotes(transaction.state.doc) : value;
	},
});

interface FootnoteNavigation {
	lastReferenceFrom: Map<string, number>;
}

export const footnoteNavigationEffect = StateEffect.define<{ id: string; referenceFrom: number }>();

export const footnoteNavigationField = StateField.define<FootnoteNavigation>({
	create: () => ({ lastReferenceFrom: new Map() }),
	update(value, transaction) {
		const lastReferenceFrom = new Map<string, number>();
		for (const [id, position] of value.lastReferenceFrom) lastReferenceFrom.set(id, transaction.changes.mapPos(position, 1));
		for (const effect of transaction.effects) {
			if (effect.is(footnoteNavigationEffect)) lastReferenceFrom.set(effect.value.id, effect.value.referenceFrom);
		}
		return { lastReferenceFrom };
	},
});

/**
 * Resolves a widget to the occurrence that it represents in the current
 * document. The source position is the occurrence identity; ordinal is only a
 * display label and is shared by repeated references such as `A[^x] ... B[^x]`.
 * The nearest same-id occurrence is a safe fallback for the brief interval in
 * which a stale widget is being replaced after an edit.
 */
export function resolveFootnoteReference(index: FootnoteIndex, widgetReference: FootnoteReference): FootnoteReference | undefined {
	const samePosition = index.references.find((reference) =>
		reference.id === widgetReference.id &&
		reference.from === widgetReference.from &&
		reference.to === widgetReference.to,
	);
	if (samePosition) return samePosition;
	return index.references
		.filter((reference) => reference.id === widgetReference.id)
		.sort((a, b) => Math.abs(a.from - widgetReference.from) - Math.abs(b.from - widgetReference.from))[0];
}

function renderedFootnote(reference: FootnoteReference, state: EditorState): boolean {
	return pointerGestureIsActive() || !selectionTouchesInlineRangeForDecoration(state, reference.from, reference.to);
}

function renderedFootnoteClusters(state: EditorState): Array<{ from: number; to: number }> {
	const clusters: Array<{ from: number; to: number }> = [];
	for (const reference of state.field(footnoteIndexField).references) {
		if (!renderedFootnote(reference, state)) continue;
		const previous = clusters.at(-1);
		if (previous?.to === reference.from) previous.to = reference.to;
		else clusters.push({ from: reference.from, to: reference.to });
	}
	return clusters;
}

function renderedFootnoteClusterContaining(state: EditorState, position: number): { from: number; to: number } | null {
	return renderedFootnoteClusters(state).find((cluster) => position >= cluster.from && position <= cluster.to) ?? null;
}

function renderedFootnoteClusterAtPosition(state: EditorState, position: number): { from: number; to: number } | null {
	const clusters = renderedFootnoteClusters(state);
	return clusters.find((cluster) => position >= cluster.from && position <= cluster.to)
		// CodeMirror can resolve a visual-row target immediately before a
		// replacement widget on one platform and at its first source boundary
		// on another. Both positions represent the same rendered row here.
		?? clusters.find((cluster) => position === cluster.from - 1)
		?? null;
}

interface RenderedFootnoteRect {
	from: number;
	to: number;
	rect: DOMRect;
	centerY: number;
}

function renderedFootnoteRects(view: EditorView): RenderedFootnoteRect[] {
	return Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.mlp-footnote-ref'))
		.map((button) => {
			const from = Number(button.dataset.referenceFrom);
			const to = Number(button.dataset.referenceTo);
			if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
			const rect = button.getBoundingClientRect();
			return { from, to, rect, centerY: (rect.top + rect.bottom) / 2 };
		})
		.filter((entry): entry is RenderedFootnoteRect => entry !== null)
		.sort((a, b) => a.from - b.from);
}

function renderedFootnotesOnVisualRow(view: EditorView, targetY: number): RenderedFootnoteRect[] {
	const rows: RenderedFootnoteRect[][] = [];
	for (const entry of renderedFootnoteRects(view)) {
		const row = rows.find((candidate) => candidate[0].centerY === entry.centerY);
		if (row) row.push(entry);
		else rows.push([entry]);
	}
	const row = rows.reduce<RenderedFootnoteRect[] | null>((best, candidate) => {
		if (!best) return candidate;
		return Math.abs(candidate[0].centerY - targetY) < Math.abs(best[0].centerY - targetY) ? candidate : best;
	}, null);
	return row && Math.abs(row[0].centerY - targetY) <= Math.max(view.defaultLineHeight, 1) ? row : [];
}

function footnoteBoundaryForVisualGoal(entries: RenderedFootnoteRect[], desiredX: number): number {
	let best: { boundary: number; distance: number } | null = null;
	for (const entry of entries) {
		const midpoint = (entry.rect.left + entry.rect.right) / 2;
		const boundary = desiredX <= midpoint ? entry.from : entry.to;
		const distance = desiredX < entry.rect.left
			? entry.rect.left - desiredX
			: desiredX > entry.rect.right
				? desiredX - entry.rect.right
				: 0;
		if (!best || distance < best.distance) best = { boundary, distance };
	}
	return best?.boundary ?? entries[0].from;
}

/**
 * Move vertically with CodeMirror's normal desired-column calculation, but
 * keep a rendered footnote cluster from being entered accidentally. Horizontal
 * movement deliberately does not use this command and therefore remains free
 * to enter a reference and reveal its Markdown source.
 */
export function moveVerticallyAvoidingFootnotes(forward: boolean): Command {
	return (view) => {
		const state = view.state;
		const ranges = state.selection.ranges.map((range) => {
			if (!range.empty) return EditorSelection.cursor(forward ? range.to : range.from);
			const startCoords = view.coordsAtPos(range.head, range.assoc || undefined);
			const startGoal = range.goalColumn ?? (startCoords
				? startCoords.left - view.contentDOM.getBoundingClientRect().left
				: undefined);
			let moved = view.moveVertically(range, forward);
			if (moved.head === range.head) moved = view.moveToLineBoundary(range, forward);
			const goalColumn = moved.goalColumn ?? startGoal;
			const cluster = renderedFootnoteClusterAtPosition(state, moved.head);
			if (!cluster || goalColumn === undefined || !startCoords) return moved;
			const targetY = (forward ? startCoords.bottom : startCoords.top) + (forward ? 1 : -1) * (view.defaultLineHeight / 2);
			const rowEntries = renderedFootnotesOnVisualRow(view, targetY)
				.filter((entry) => entry.from >= cluster.from && entry.to <= cluster.to);
			if (rowEntries.length === 0) return moved;
			const desiredX = view.contentDOM.getBoundingClientRect().left + goalColumn;
			const boundary = footnoteBoundaryForVisualGoal(rowEntries, desiredX);
			return EditorSelection.cursor(boundary, moved.assoc, moved.bidiLevel ?? undefined, goalColumn);
		});
		const selection = EditorSelection.create(ranges, state.selection.mainIndex);
		if (selection.eq(state.selection, true)) return false;
		// The custom command replaces CodeMirror's built-in vertical-motion
		// command, so it must request the same visibility guarantee itself. The
		// default "nearest" strategy changes scrollTop only by the overflow
		// needed to reveal the main caret; it neither centers the caret nor jumps
		// by a fixed number of lines. This is especially important when the
		// footnote guard snaps a candidate to the edge of a rendered cluster.
		view.dispatch({
			selection,
			effects: EditorView.scrollIntoView(selection.main.head, { y: 'nearest' }),
			userEvent: 'select.line',
		});
		return true;
	};
}

function domCaretPosition(view: EditorView, event: MouseEvent): { pos: number; assoc: -1 | 1 } | null {
	const caretRange = document.caretRangeFromPoint?.(event.clientX, event.clientY);
	if (!caretRange?.startContainer) return null;
	try {
		return { pos: view.posAtDOM(caretRange.startContainer, caretRange.startOffset), assoc: 1 };
	} catch {
		return null;
	}
}

function pointerPosition(view: EditorView, event: MouseEvent): { pos: number; assoc: -1 | 1 } {
	const native = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY });
	if (!native) return { pos: view.state.selection.main.head, assoc: 1 };
	const cluster = renderedFootnoteClusterContaining(view.state, native.pos);
	if (!cluster) return native;
	const dom = domCaretPosition(view, event);
	return dom && (dom.pos <= cluster.from || dom.pos >= cluster.to) ? dom : native;
}

/**
 * Gives prose-side clicks around rendered footnotes their final position on
 * the initial mouse selection. The browser's DOM caret is consulted only when
 * CodeMirror's replacement-widget hit test lands inside a rendered cluster;
 * widget clicks and drags otherwise retain CodeMirror's normal behavior.
 */
export function createFootnoteMouseSelectionStyle(): (view: EditorView, event: MouseEvent) => MouseSelectionStyle | null {
	return (view, event) => {
		if (event.button !== 0 || event.detail > 1) return null;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest('.mlp-footnote-ref')) return null;
		const line = (target?.closest('.cm-line') ?? document.elementFromPoint(event.clientX, event.clientY)?.closest('.cm-line')) as HTMLElement | null;
		if (!line?.querySelector('.mlp-footnote-ref')) return null;

		let start = pointerPosition(view, event);
		let startSelection = view.state.selection;
		return {
			update(update: ViewUpdate) {
				if (!update.docChanged) return;
				start = { pos: update.changes.mapPos(start.pos), assoc: start.assoc };
				startSelection = startSelection.map(update.changes);
			},
			get(currentEvent, extend, multiple) {
				const current = pointerPosition(view, currentEvent);
				let range = EditorSelection.cursor(current.pos, current.assoc);
				if (start.pos !== current.pos && !extend) {
					const from = Math.min(start.pos, range.from);
					const to = Math.max(start.pos, range.to);
					range = from < range.from
						? EditorSelection.range(from, to, range.assoc)
						: EditorSelection.range(to, from, range.assoc);
				}
				if (extend) return startSelection.replaceRange(startSelection.main.extend(range.from, range.to, range.assoc));
				if (multiple) return startSelection.addRange(range);
				return EditorSelection.create([range]);
			},
		};
	};
}

export class FootnoteReferenceWidget extends WidgetType {
	constructor(private readonly reference: FootnoteReference) {
		super();
	}

	eq(other: FootnoteReferenceWidget): boolean {
		return other.reference.id === this.reference.id &&
			other.reference.ordinal === this.reference.ordinal &&
			other.reference.from === this.reference.from &&
			other.reference.to === this.reference.to;
	}

	toDOM(view: EditorView): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'mlp-footnote-ref';
		button.dataset.referenceFrom = String(this.reference.from);
		button.dataset.referenceTo = String(this.reference.to);
		button.textContent = String(this.reference.ordinal);
		button.setAttribute('aria-label', `脚注 ${this.reference.ordinal}`);
		button.title = `跳转到脚注 ${this.reference.ordinal}`;
		const activate = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			const index = view.state.field(footnoteIndexField);
			const currentReference = resolveFootnoteReference(index, this.reference);
			const definition = currentReference ? index.definitions.get(currentReference.id) : undefined;
			if (!definition) return;
			view.dispatch({
				selection: { anchor: definition.markerFrom },
				effects: footnoteNavigationEffect.of({ id: this.reference.id, referenceFrom: currentReference?.from ?? this.reference.from }),
				scrollIntoView: true,
			});
			view.focus();
		};
		let gesture: PointerGestureStart | null = null;
		button.addEventListener('mousedown', (event) => {
			gesture = beginPrimaryPointerGesture(event);
		});
		button.addEventListener('click', (event) => {
			if (event instanceof MouseEvent && event.detail > 0 && !isPointerClick(gesture, event, view.state.selection.main.empty)) {
				gesture = null;
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			gesture = null;
			activate(event);
		});
		return button;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

export class FootnoteBackWidget extends WidgetType {
	constructor(private readonly id: string) {
		super();
	}

	eq(other: FootnoteBackWidget): boolean {
		return other.id === this.id;
	}

	toDOM(view: EditorView): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'mlp-footnote-back';
		button.textContent = '↩';
		button.setAttribute('aria-label', `返回脚注 ${this.id} 的引用`);
		button.title = '返回上次使用的脚注引用';
		const activate = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			const index = view.state.field(footnoteIndexField);
			const navigation = view.state.field(footnoteNavigationField);
			const target = navigation.lastReferenceFrom.get(this.id) ?? index.references.find((reference) => reference.id === this.id)?.from;
			if (target === undefined) return;
			view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
			view.focus();
		};
		button.addEventListener('mousedown', (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		button.addEventListener('click', activate);
		return button;
	}

	ignoreEvent(): boolean {
		return false;
	}
}
