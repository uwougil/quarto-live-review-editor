import type { EditorView } from '@codemirror/view';
import { allowRevealOnce } from './cmUtils';

/**
 * The "show me the source" control shared by every rendered block widget
 * (tables, Mermaid diagrams, frontmatter).
 *
 * Each of these widgets replaces a run of Markdown with a rendered view, and
 * each needs a way back to the text behind it — to fix a diagram's syntax, to
 * add a table row, to correct a YAML key. Putting the caret inside the block is
 * what does it: `cursorTouchesRange` (cmUtils.ts) then withholds the widget and
 * the raw source shows through.
 *
 * Clicking the block itself used to be that gesture, and for Mermaid and
 * frontmatter it still is. It cannot be for tables, where a click now edits a
 * cell in place, so the way back had to become an explicit control. Giving the
 * same control to every block keeps one visible, predictable route to the
 * source rather than a rule that differs per block type.
 */
export interface CodeModeButtonOptions {
	/** Element the button is positioned against; also the fallback caret target. */
	anchor: HTMLElement;
	/**
	 * Where to put the caret. Defaults to the anchor's own document position,
	 * which is the start of the block.
	 */
	caretPos?: () => number;
	/** Runs before the caret moves — used by the table to save a pending edit. */
	beforeShow?: () => number | null;
}

/** Builds the `</>` button. The caller decides where to place it. */
export function createCodeModeButton(view: EditorView, options: CodeModeButtonOptions): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'mlp-code-mode-btn';
	// Icon only: the glyph is set in the editor's monospace face by the stylesheet
	// so it reads as code, and what it does is spelled out for pointer users in
	// `title` and for assistive tech in `aria-label`.
	button.textContent = '</>';
	button.title = '源码模式：显示并直接编辑 Markdown 源码';
	button.setAttribute('aria-label', '切换到源码模式');

	// The press must not reach the block underneath. Without this, the block's own
	// click-to-source handler (or, for a table, the cell under the button) would
	// fire first and the button would never get its turn.
	button.addEventListener('mousedown', (event) => {
		event.preventDefault();
		event.stopPropagation();
	});
	button.addEventListener('pointerdown', (event) => event.stopPropagation());
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		// This reveal is deliberate, so lift the guard that suppresses an accidental
		// one (cmUtils.ts). The button's own press never reaches the block, so the
		// guard would otherwise still be set and the source would not appear.
		allowRevealOnce();
		const committed = options.beforeShow?.() ?? null;
		const pos = committed ?? options.caretPos?.() ?? view.posAtDOM(options.anchor);
		view.dispatch({
			selection: { anchor: Math.min(Math.max(pos, 0), view.state.doc.length) },
			scrollIntoView: true,
		});
		view.focus();
	});
	return button;
}

/**
 * Wraps `inner` in a positioned box carrying a code-mode button in its corner.
 *
 * Returns the box, for the caller to hand to `wrapBlockWidget`.
 */
export function withCodeModeButton(
	view: EditorView,
	inner: HTMLElement,
	options: CodeModeButtonOptions,
): HTMLElement {
	const host = document.createElement('div');
	host.className = 'mlp-code-mode-host';
	host.appendChild(inner);
	host.appendChild(createCodeModeButton(view, options));
	return host;
}

/**
 * "Copy this code block" button.
 *
 * A fenced code block is not a widget — it stays as real editor lines, with the
 * ``` fences merely hidden while the caret is elsewhere. Selecting it by hand
 * therefore drags in those hidden fence lines and whatever indentation the
 * block sits under, so what lands on the clipboard needs cleaning up by hand.
 * This copies exactly the block's content instead.
 *
 * `getCode` is read at click time, not at build time, so the button copies what
 * the block says now rather than what it said when the button was created.
 */
/** Two overlapping sheets — the usual "copy" mark, and a glyph, not an icon font. */
const COPY_GLYPH = '⧉';

export function createCopyCodeButton(getCode: () => string): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	// Same shape and treatment as the `</>` control, so the two read as one family
	// of block chrome: a short glyph in the editor's monospace face, not a word.
	button.className = 'mlp-copy-code-btn';
	button.textContent = COPY_GLYPH;
	button.title = '复制此代码块';
	button.setAttribute('aria-label', '复制代码块');

	// The press must not reach the editor underneath, or CodeMirror moves the
	// caret into the block — which un-hides the fences and reflows the lines the
	// button is sitting on.
	button.addEventListener('mousedown', (event) => {
		event.preventDefault();
		event.stopPropagation();
	});
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		const done = (ok: boolean) => {
			// Feedback has to be visible: the clipboard gives none of its own, and
			// without it a click looks like nothing happened.
			button.textContent = ok ? '✓' : '✕';
			button.classList.toggle('mlp-copy-code-btn-done', ok);
			button.classList.toggle('mlp-copy-code-btn-failed', !ok);
			setTimeout(() => {
				button.textContent = COPY_GLYPH;
				button.classList.remove('mlp-copy-code-btn-done', 'mlp-copy-code-btn-failed');
			}, 1200);
		};
		// `navigator.clipboard` is unavailable in some webview configurations, and
		// rejects when the document is not focused; neither should throw past here.
		try {
			const clipboard = navigator.clipboard;
			if (!clipboard?.writeText) {
				done(false);
				return;
			}
			clipboard.writeText(getCode()).then(
				() => done(true),
				() => done(false),
			);
		} catch {
			done(false);
		}
	});
	return button;
}
