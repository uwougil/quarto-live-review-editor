import type { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import katex from 'katex';
import { mathRangesForState, type MathRange } from './math';
import { pointerGestureIsActive } from './cmUtils';

const PREVIEW_GAP_PX = 8;
const PREVIEW_EDGE_PX = 8;

/**
 * Returns the formula currently being edited by a collapsed caret.
 *
 * The returned range comes from the editor state, so the preview never owns a
 * second copy of the source or a second editable state. Non-empty selections
 * intentionally have no preview: Issue #40 keeps those formulas rendered for
 * copy/selection gestures, while a collapsed caret is the explicit source-edit
 * gesture.
 */
export function editingMathRange(state: EditorState): MathRange | null {
	if (pointerGestureIsActive()) return null;
	const selection = state.selection.main;
	if (!selection.empty) return null;
	return mathRangesForState(state).find((range) => selection.head > range.from && selection.head < range.to) ?? null;
}

function renderMath(element: HTMLElement, range: MathRange): void {
	element.className = range.display ? 'mlp-math mlp-math-display' : 'mlp-math mlp-math-inline';
	element.setAttribute('role', 'math');
	element.setAttribute('aria-label', range.tex);
	try {
		element.innerHTML = katex.renderToString(range.tex, {
			displayMode: range.display,
			throwOnError: false,
			output: 'htmlAndMathml',
		});
	} catch {
		// KaTeX normally renders parse errors as a .katex-error element when
		// throwOnError is false. Some malformed intermediate input can still throw;
		// showing the TeX text keeps the edit path usable in that case.
		element.textContent = range.tex;
	}
}

function clamp(value: number, lower: number, upper: number): number {
	return Math.min(Math.max(value, lower), Math.max(lower, upper));
}

/**
 * A non-document preview for the formula source currently under the caret.
 *
 * It is deliberately a ViewPlugin instead of a decoration. A decoration would
 * either replace the source (breaking editing) or add a box to the document's
 * measured flow (changing line heights and scroll geometry). The overlay is
 * positioned from CodeMirror's current caret coordinates after layout and is
 * never written back to the document.
 */
class MathEditPreviewPlugin {
	readonly dom: HTMLDivElement;
	private frame: number | undefined;
	private disposed = false;
	private renderedKey = '';
	private readonly onScroll = () => this.scheduleUpdate();
	private readonly onResize = () => this.scheduleUpdate();

	constructor(private readonly view: EditorView) {
		this.dom = document.createElement('div');
		this.dom.className = 'mlp-math-edit-preview';
		this.dom.hidden = true;
		this.dom.setAttribute('aria-label', '公式实时预览');
		this.dom.setAttribute('aria-live', 'polite');
		view.dom.appendChild(this.dom);
		view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
		window.addEventListener('resize', this.onResize);
		this.updateNow();
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) this.scheduleUpdate();
	}

	destroy(): void {
		this.disposed = true;
		if (this.frame !== undefined) cancelAnimationFrame(this.frame);
		this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
		window.removeEventListener('resize', this.onResize);
		this.dom.remove();
	}

	private scheduleUpdate(): void {
		if (this.disposed || this.frame !== undefined) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = undefined;
			if (!this.disposed) this.updateNow();
		});
	}

	private updateNow(): void {
		const range = editingMathRange(this.view.state);
		if (!range) {
			this.dom.hidden = true;
			this.renderedKey = '';
			return;
		}

		const key = `${range.display ? 'display' : 'inline'}:${range.tex}`;
		if (key !== this.renderedKey) {
			const math = document.createElement(range.display ? 'div' : 'span');
			renderMath(math, range);
			this.dom.replaceChildren(math);
			this.dom.dataset.display = String(range.display);
			this.renderedKey = key;
		}

		this.positionAtRange(range);
	}

	private positionAtRange(range: MathRange): void {
		const coords = this.view.coordsAtPos(this.view.state.selection.main.head);
		if (!coords) {
			this.dom.hidden = true;
			return;
		}

		const editorRect = this.view.dom.getBoundingClientRect();
		const availableWidth = Math.max(1, editorRect.width - PREVIEW_EDGE_PX * 2);
		this.dom.style.maxWidth = `${availableWidth}px`;
		this.dom.style.visibility = 'hidden';
		this.dom.hidden = false;

		const previewRect = this.dom.getBoundingClientRect();
		const left = clamp(
			coords.left - editorRect.left,
			PREVIEW_EDGE_PX,
			editorRect.width - previewRect.width - PREVIEW_EDGE_PX,
		);
		const rangeStart = this.view.coordsAtPos(range.from);
		const rangeEnd = this.view.coordsAtPos(range.to, -1);
		// A display formula can span several source lines. Anchor below or above
		// the whole source range when those coordinates are available, otherwise
		// fall back to the active caret. This keeps the preview from covering the
		// closing `$$` line while the user is editing the body.
		const sourceTop = Math.min(coords.top, rangeStart?.top ?? coords.top);
		const sourceBottom = Math.max(coords.bottom, rangeEnd?.bottom ?? coords.bottom);
		const below = sourceBottom - editorRect.top + PREVIEW_GAP_PX;
		const above = sourceTop - editorRect.top - previewRect.height - PREVIEW_GAP_PX;
		const bottomLimit = editorRect.height - PREVIEW_EDGE_PX;
		const top = below + previewRect.height <= bottomLimit || above < PREVIEW_EDGE_PX ? below : above;

		this.dom.style.left = `${left}px`;
		this.dom.style.top = `${Math.max(PREVIEW_EDGE_PX, top)}px`;
		this.dom.style.visibility = 'visible';
	}
}

// The plugin appends its overlay manually in the constructor so it can measure
// it immediately after creation. Supplying `dom` in the plugin spec as well
// would make CodeMirror append the same node a second time during construction.
export const mathEditPreview = ViewPlugin.fromClass(MathEditPreviewPlugin);
