import { StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';
import { WidgetType, type EditorView } from '@codemirror/view';
import { findFenceSpans, scanSourceLines } from '../quarto/fence';

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

export class FootnoteReferenceWidget extends WidgetType {
	constructor(private readonly reference: FootnoteReference) {
		super();
	}

	eq(other: FootnoteReferenceWidget): boolean {
		return other.reference.id === this.reference.id && other.reference.ordinal === this.reference.ordinal;
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
			const definition = index.definitions.get(this.reference.id);
			if (!definition) return;
			view.dispatch({
				selection: { anchor: definition.markerFrom },
				effects: footnoteNavigationEffect.of({ id: this.reference.id, referenceFrom: this.reference.from }),
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
