import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import { mathRangeTouchesSelection, mathRangesForState, type MathRange } from './math';

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
		element.addEventListener('mousedown', (event) => {
			event.preventDefault();
			// The widget DOM may be reused after edits shifted its source range. Ask
			// CodeMirror for the node's current position instead of using the range
			// captured when this MathWidget instance was first constructed.
			const currentFrom = view.posAtDOM(element);
			view.dispatch({ selection: { anchor: currentFrom + 1 }, scrollIntoView: true });
			view.focus();
		});
		return element;
	}

	ignoreEvent(): boolean {
		return false;
	}
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
		if (mathRangeTouchesSelection(state, range)) continue;
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
		if (transaction.docChanged || transaction.selection) return buildMathDecorations(transaction.state);
		return value;
	},
	provide: (field) => EditorView.decorations.from(field),
});
