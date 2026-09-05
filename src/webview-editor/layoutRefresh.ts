import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

const refreshLayoutEffect = StateEffect.define<number>();

class LayoutRefreshWidget extends WidgetType {
	constructor(private readonly serial: number) {
		super();
	}

	eq(other: LayoutRefreshWidget): boolean {
		return other.serial === this.serial;
	}

	toDOM(): HTMLElement {
		const marker = document.createElement('span');
		marker.className = 'mlp-layout-refresh-marker';
		marker.setAttribute('aria-hidden', 'true');
		return marker;
	}

	get estimatedHeight(): number {
		return 0;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function buildRefreshDecoration(state: EditorState, serial: number): DecorationSet {
	if (state.doc.length === 0) return Decoration.none;
	return Decoration.set([Decoration.widget({ widget: new LayoutRefreshWidget(serial), side: 1 }).range(state.doc.length)]);
}

/** A state-backed, zero-height decoration that makes CodeMirror redraw its tile. */
export const layoutRefreshField = StateField.define<DecorationSet>({
	create: (state) => buildRefreshDecoration(state, 0),
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(refreshLayoutEffect)) return buildRefreshDecoration(transaction.state, effect.value);
		}
		return transaction.docChanged ? buildRefreshDecoration(transaction.state, 0) : value;
	},
	provide: (field) => EditorView.decorations.from(field),
});

let serial = 0;
const scheduledViews = new WeakSet<EditorView>();

/**
 * Re-enters CodeMirror's normal redraw path after browser layout has settled.
 * This is needed for style-tag changes and for ViewPlugin decorations that
 * replace source markers after the parser advances. It deliberately uses a
 * state-backed decoration instead of private height-map APIs or input-event
 * interception.
 */
export function refreshEditorLayout(view: EditorView): void {
	if (scheduledViews.has(view)) return;
	scheduledViews.add(view);
	const target = view;
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			scheduledViews.delete(target);
			if (!target.dom.isConnected) return;
			target.dispatch({ effects: refreshLayoutEffect.of(++serial) });
		});
	});
}
