import { EditorSelection, StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';
import { EditorView, WidgetType, type Command } from '@codemirror/view';
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

function renderedFootnoteClusterAt(state: EditorState, position: number): { from: number; to: number } | null {
	return renderedFootnoteClusters(state).find((cluster) => position > cluster.from && position < cluster.to) ?? null;
}

function renderedFootnoteClusterAtGoal(
	view: EditorView,
	state: EditorState,
	position: number,
	goalColumn: number | undefined,
): { from: number; to: number } | null {
	const inside = renderedFootnoteClusterAt(state, position);
	if (inside || goalColumn === undefined) return inside;
	const desiredX = view.contentDOM.getBoundingClientRect().left + goalColumn;
	return renderedFootnoteClusters(state).find((cluster) => {
		if (position !== cluster.from && position !== cluster.to) return false;
		const fromCoords = view.coordsAtPos(cluster.from, 1);
		const toCoords = view.coordsAtPos(cluster.to, -1);
		if (!fromCoords || !toCoords) return false;
		const left = Math.min(fromCoords.left, toCoords.left);
		const right = Math.max(fromCoords.right, toCoords.right);
		return desiredX >= left && desiredX <= right;
	}) ?? null;
}

function footnoteBoundaryForGoal(
	view: EditorView,
	cluster: { from: number; to: number },
	goalColumn: number | undefined,
	forward: boolean,
): number {
	if (goalColumn === undefined) return forward ? cluster.to : cluster.from;
	const fromCoords = view.coordsAtPos(cluster.from, 1);
	const toCoords = view.coordsAtPos(cluster.to, -1);
	if (!fromCoords || !toCoords) return forward ? cluster.to : cluster.from;
	const desiredX = view.contentDOM.getBoundingClientRect().left + goalColumn;
	const fromX = (fromCoords.left + fromCoords.right) / 2;
	const toX = (toCoords.left + toCoords.right) / 2;
	// Replacement widgets can report the boundary coordinate associated with
	// the opposite side depending on the `assoc` direction and browser. Map
	// physical left/right back to the logical source edges before choosing the
	// endpoint; otherwise a left-column vertical move enters the cluster's end.
	const leftX = Math.min(fromX, toX);
	const rightX = Math.max(fromX, toX);
	return Math.abs(desiredX - leftX) <= Math.abs(desiredX - rightX) ? cluster.from : cluster.to;
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
			const cluster = renderedFootnoteClusterAtGoal(view, state, moved.head, goalColumn);
			if (!cluster) return moved;
			const boundary = footnoteBoundaryForGoal(view, cluster, goalColumn, forward);
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

/**
 * Protects only prose-side pointer placement around a rendered reference
 * cluster. It asks the browser for the caret in the clicked text node and
 * converts that DOM point back to a source position. This prevents CodeMirror's
 * replacement-widget hit test from choosing the far edge of `[^1][^2]`, while
 * clicks on the superscript itself continue to the widget's navigation handler.
 */
export function createFootnoteMouseHandler(): ReturnType<typeof EditorView.domEventHandlers> {
	let gesture: PointerGestureStart | null = null;
	let correctedOnMouseup = false;
	const correctClick = (event: MouseEvent, view: EditorView): boolean => {
		// Native hit testing may leave the old selection non-empty until the
		// click event has completed. Pointer slop, rather than that transient
		// selection state, is the reliable click-vs-drag discriminator here.
		if (!gesture || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) return false;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest('.mlp-footnote-ref')) return false;
		const line = (target?.closest('.cm-line') ?? document.elementFromPoint(event.clientX, event.clientY)?.closest('.cm-line')) as HTMLElement | null;
		if (!line) return false;
		// A reference may already be showing source when the gesture begins (for
		// example after ArrowRight entered one occurrence). Use the source index as
		// the stable cluster identity and fall back to source coordinates for any
		// button that is not currently mounted.
		const buttons = Array.from(line.querySelectorAll<HTMLElement>('.mlp-footnote-ref'));
		const buttonByRange = new Map<string, HTMLElement>();
		for (const button of buttons) {
			const from = Number(button.dataset.referenceFrom);
			const to = Number(button.dataset.referenceTo);
			if (Number.isFinite(from) && Number.isFinite(to)) buttonByRange.set(`${from}:${to}`, button);
		}
		const head = view.state.selection.main.head;
		const sourceLine = view.state.doc.lineAt(head);
		const references = view.state.field(footnoteIndexField).references.filter((reference) =>
			reference.from >= sourceLine.from && reference.to <= sourceLine.to);
		const entries = references.map((reference) => {
			const from = reference.from;
			const to = reference.to;
			const button = buttonByRange.get(`${from}:${to}`) ?? null;
			const fromCoords = button ? null : view.coordsAtPos(from, 1);
			const toCoords = button ? null : view.coordsAtPos(to, -1);
			const domRect = button?.getBoundingClientRect();
			if ((!fromCoords || !toCoords) && !domRect) return null;
			const rect = domRect ?? {
				left: Math.min(fromCoords!.left, toCoords!.left),
				right: Math.max(fromCoords!.right, toCoords!.right),
				top: Math.min(fromCoords!.top, toCoords!.top),
				bottom: Math.max(fromCoords!.bottom, toCoords!.bottom),
			};
			return { from: reference.from, to: reference.to, rect, centerY: (rect.top + rect.bottom) / 2 };
		}).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
		const clusters: Array<typeof entries> = [];
		for (const entry of entries) {
			const cluster = clusters.at(-1);
			if (cluster?.at(-1)?.to === entry.from) cluster.push(entry);
			else clusters.push([entry]);
		}
		const clusterEntries = clusters.find((cluster) => {
			const from = cluster[0].from;
			const to = cluster.at(-1)?.to ?? from;
			return Math.abs(head - from) <= 1 || Math.abs(head - to) <= 1;
		});
		if (!clusterEntries || clusterEntries.length === 0) return false;
		const rows: Array<typeof entries> = [];
		for (const entry of clusterEntries) {
			const row = rows.find((candidate) => {
				const center = candidate.reduce((sum, item) => sum + item.centerY, 0) / candidate.length;
				return Math.abs(center - entry.centerY) <= 2;
			});
			if (row) row.push(entry);
			else rows.push([entry]);
		}
		const row = rows.reduce((best, candidate) => {
			const bestDistance = Math.abs(event.clientY - best.reduce((sum, entry) => sum + entry.centerY, 0) / best.length);
			const candidateDistance = Math.abs(event.clientY - candidate.reduce((sum, entry) => sum + entry.centerY, 0) / candidate.length);
			return candidateDistance < bestDistance ? candidate : best;
		});
		const rowFrom = row[0].from;
		const rowTo = row[row.length - 1].to;
		const left = Math.min(...row.map((entry) => entry.rect.left));
		const right = Math.max(...row.map((entry) => entry.rect.right));
		const clusterFrom = clusterEntries[0].from;
		const clusterTo = clusterEntries.at(-1)?.to ?? clusterFrom;
		if (head < clusterFrom || head > clusterTo) return false;
		// When the browser hit-tests the one-pixel seam between a replacement
		// widget and following prose, the native selection may remain at the
		// cluster end even though the user clicked the prose. Prefer the DOM
		// caret position whenever it resolves clearly outside the cluster.
		const caretRange = document.caretRangeFromPoint?.(event.clientX, event.clientY);
		if (caretRange?.startContainer) {
			try {
				const domPos = view.posAtDOM(caretRange.startContainer, caretRange.startOffset);
				if (domPos < clusterFrom || domPos > clusterTo) {
					event.preventDefault();
					event.stopPropagation();
					view.dispatch({ selection: { anchor: domPos }, userEvent: 'select.pointer' });
					view.focus();
					return true;
				}
			} catch {
				// Ignore nodes outside CodeMirror's content DOM.
			}
		}
		const desired = Math.abs(event.clientX - left) <= Math.abs(event.clientX - right) ? clusterFrom : clusterTo;
		if (desired === head) return false;
		event.preventDefault();
		event.stopPropagation();
		view.dispatch({ selection: { anchor: desired }, userEvent: 'select.pointer' });
		view.focus();
		return true;
	};
	return EditorView.domEventHandlers({
		mousedown(event) {
			gesture = event instanceof MouseEvent ? beginPrimaryPointerGesture(event) : null;
			return false;
		},
		mouseup(event, view) {
			if (!(event instanceof MouseEvent)) return false;
			if (!isPointerClick(gesture, event, view.state.selection.main.empty)) {
				gesture = null;
				correctedOnMouseup = false;
				return false;
			}
			correctedOnMouseup = correctClick(event, view);
			return correctedOnMouseup;
		},
		click(event, view) {
			if (!(event instanceof MouseEvent)) return false;
			if (correctedOnMouseup) {
				correctedOnMouseup = false;
				gesture = null;
				return true;
			}
			const corrected = correctClick(event, view);
			gesture = null;
			return corrected;
		},
	});
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
