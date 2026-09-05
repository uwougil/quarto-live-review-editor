import { EditorSelection, StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';
import { EditorView, WidgetType, type Command } from '@codemirror/view';
import { findFenceSpans, scanSourceLines } from '../quarto/fence';
import { selectionTouchesInlineRange } from '../shared/selection';

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
	return !selectionTouchesInlineRange(state, reference.from, reference.to);
}

function renderedFootnoteClusterAt(state: EditorState, position: number): { from: number; to: number } | null {
	const references = state.field(footnoteIndexField).references;
	const index = references.findIndex((reference) =>
		renderedFootnote(reference, state) && position > reference.from && position < reference.to,
	);
	if (index < 0) return null;
	let from = references[index].from;
	let to = references[index].to;
	for (let i = index - 1; i >= 0; i -= 1) {
		const previous = references[i];
		if (!renderedFootnote(previous, state) || previous.to !== from) break;
		from = previous.from;
	}
	for (let i = index + 1; i < references.length; i += 1) {
		const next = references[i];
		if (!renderedFootnote(next, state) || next.from !== to) break;
		to = next.to;
	}
	return { from, to };
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
			let moved = view.moveVertically(range, forward);
			if (moved.head === range.head) moved = view.moveToLineBoundary(range, forward);
			const cluster = renderedFootnoteClusterAt(state, moved.head);
			if (!cluster) return moved;
			const boundary = forward ? cluster.to : cluster.from;
			return EditorSelection.cursor(boundary, moved.assoc, moved.bidiLevel ?? undefined, moved.goalColumn);
		});
		const selection = EditorSelection.create(ranges, state.selection.mainIndex);
		if (selection.eq(state.selection, true)) return false;
		view.dispatch({ selection, userEvent: 'select.line' });
		return true;
	};
}

interface BrowserCaretPoint {
	node: Node;
	offset: number;
}

function lineElementFor(node: Node): HTMLElement | null {
	const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
	return element?.closest('.cm-line') ?? null;
}

function caretPointAt(event: MouseEvent): BrowserCaretPoint | null {
	const documentWithCaret = document as Document & {
		caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null;
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	};
	const range = documentWithCaret.caretRangeFromPoint?.(event.clientX, event.clientY);
	if (range) return { node: range.startContainer, offset: range.startOffset };
	const position = documentWithCaret.caretPositionFromPoint?.(event.clientX, event.clientY);
	return position ? { node: position.offsetNode, offset: position.offset } : null;
}

/**
 * Protects only prose-side pointer placement around a rendered reference
 * cluster. It asks the browser for the caret in the clicked text node and
 * converts that DOM point back to a source position. This prevents CodeMirror's
 * replacement-widget hit test from choosing the far edge of `[^1][^2]`, while
 * clicks on the superscript itself continue to the widget's navigation handler.
 */
export function createFootnoteMouseHandler(): ReturnType<typeof EditorView.domEventHandlers> {
	return EditorView.domEventHandlers({
		mousedown(event, view) {
			if (!(event instanceof MouseEvent) || event.button !== 0) return false;
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest('.mlp-footnote-ref')) return false;
			const point = caretPointAt(event);
			if (!point) return false;
			const line = lineElementFor(point.node);
			if (!line) return false;
			const buttons = Array.from(line.querySelectorAll('.mlp-footnote-ref'));
			if (buttons.length === 0) return false;
			const firstButton = buttons[0];
			const lastButton = buttons[buttons.length - 1];
			const nodeBeforeFirst = Boolean(point.node.compareDocumentPosition(firstButton) & Node.DOCUMENT_POSITION_FOLLOWING);
			const nodeAfterLast = Boolean(lastButton.compareDocumentPosition(point.node) & Node.DOCUMENT_POSITION_FOLLOWING);
			if (!nodeBeforeFirst && !nodeAfterLast) return false;

			let position: number;
			try {
				position = view.posAtDOM(point.node, point.offset);
			} catch {
				return false;
			}
			const index = view.state.field(footnoteIndexField);
			const lineReferences = index.references.filter((reference) => {
				if (!renderedFootnote(reference, view.state)) return false;
				try {
					return lineElementFor(view.domAtPos(reference.from, 1).node) === line;
				} catch {
					return false;
				}
			}).sort((a, b) => a.from - b.from);
			if (lineReferences.length === 0) return false;
			const firstReference = lineReferences[0];
			const lastReference = lineReferences[lineReferences.length - 1];
			const desired = nodeBeforeFirst
				? Math.min(position, firstReference.from)
				: Math.max(position, lastReference.to);
			event.preventDefault();
			event.stopPropagation();
			view.dispatch({ selection: { anchor: desired }, userEvent: 'select.pointer' });
			view.focus();
			return true;
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
