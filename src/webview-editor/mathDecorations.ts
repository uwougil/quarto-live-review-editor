import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import { mathRangesForState, type MathRange } from './math';
import { pointerGestureIsActive } from './cmUtils';
import { refreshSyntaxDecorations } from './decorationRefresh';

class MathWidget extends WidgetType {
	constructor(private readonly range: MathRange) {
		super();
	}

	eq(other: MathWidget): boolean {
		// Source offsets are placement metadata, not rendered identity. An edit
		// before this formula may move it without changing its DOM; keeping the
		// existing node avoids rerendering every later formula in the document.
		return this.range.display === other.range.display && this.range.tex === other.range.tex;
	}

	toDOM(view: EditorView): HTMLElement {
		const element = document.createElement(this.range.display ? 'div' : 'span');
		element.className = this.range.display ? 'mlp-math mlp-math-display' : 'mlp-math mlp-math-inline';
		element.setAttribute('role', 'math');
		element.setAttribute('aria-label', this.range.tex);
		try {
			element.innerHTML = katex.renderToString(this.range.tex, {
				displayMode: this.range.display,
				throwOnError: false,
				output: 'htmlAndMathml',
			});
		} catch {
			element.textContent = this.range.tex;
		}
		let press: { x: number; y: number } | null = null;
		let swallowClick = false;
		element.addEventListener('mousedown', (event) => {
			if (event instanceof MouseEvent && event.button === 0) press = { x: event.clientX, y: event.clientY };
		});
		element.addEventListener('mouseup', (event) => {
			if (!(event instanceof MouseEvent) || !press || event.button !== 0) return;
			const click = Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4;
			press = null;
			if (!click || !view.state.selection.main.empty) return;
			event.preventDefault();
			event.stopPropagation();
			// The widget DOM may be reused after edits shifted its source range. Ask
			// CodeMirror for the node's current position instead of using the range
			// captured when this MathWidget instance was first constructed.
			const currentFrom = view.posAtDOM(element);
			view.dispatch({ selection: { anchor: currentFrom + 1 }, scrollIntoView: true });
			view.focus();
			swallowClick = true;
		});
		element.addEventListener('click', (event) => {
			if (!swallowClick) return;
			swallowClick = false;
			event.preventDefault();
			event.stopPropagation();
		});
		return element;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * Only a collapsed caret strictly inside a formula is an editing request.
 * A non-empty selection is a copy/formatting gesture and must keep the rendered
 * formula stable instead of swapping KaTeX for raw `$...$` source underneath
 * the user's selection.
 */
function mathRangeHasEditingCaret(state: EditorState, range: MathRange): boolean {
	return state.selection.ranges.some((selection) =>
		selection.empty && selection.head > range.from && selection.head < range.to,
	);
}

/**
 * Math ranges are independent of the Markdown syntax tree, but their widgets
 * still belong in a StateField. A multi-line `$$...$$` replacement removes
 * line breaks, which CodeMirror only permits for block decorations supplied by
 * a StateField—not for a ViewPlugin decoration set. Keeping the field's full
 * range set is cheap (the DOM remains viewport-virtualized) and makes display
 * math valid even when it is first reached near the end of a long document.
 */
function buildMathDecorations(state: EditorState): DecorationSet {
	const decorations: Range<Decoration>[] = [];
	for (const range of mathRangesForState(state)) {
		if (!pointerGestureIsActive() && mathRangeHasEditingCaret(state, range)) continue;
		const fromLine = state.doc.lineAt(range.from);
		const toLine = state.doc.lineAt(range.to);
		if (fromLine.number !== toLine.number) {
			// A block replacement must consume complete lines. An unusual indented or
			// inline-starting multi-line expression is left as source rather than
			// asking CodeMirror to replace a partial line break illegally.
			if (range.from !== fromLine.from || range.to !== toLine.to) continue;
			decorations.push(Decoration.replace({ widget: new MathWidget(range), block: true }).range(range.from, range.to));
		} else {
			decorations.push(Decoration.replace({ widget: new MathWidget(range) }).range(range.from, range.to));
		}
	}
	return Decoration.set(decorations, true);
}

export const mathDecorationsField = StateField.define<DecorationSet>({
	create: buildMathDecorations,
	update(value, transaction) {
		if (transaction.docChanged) return buildMathDecorations(transaction.state);
		if (transaction.selection && pointerGestureIsActive()) return value;
		if (transaction.selection || transaction.effects.some((effect) => effect.is(refreshSyntaxDecorations))) {
			return buildMathDecorations(transaction.state);
		}
		return value;
	},
	provide: (field) => EditorView.decorations.from(field),
});