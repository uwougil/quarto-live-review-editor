/**
 * Spacing wrapper for block widgets (rendered tables, Mermaid diagrams,
 * frontmatter).
 *
 * CodeMirror measures a block widget's height with `getBoundingClientRect()`,
 * which reports a *border box* — it excludes margin. Vertical `margin` on a
 * widget's root element is therefore real layout space the height map never
 * accounts for, and the error accumulates down the document: every widget
 * silently shifts CodeMirror's idea of where the following lines are, so
 * clicks land on the wrong line, the caret sits below where it belongs, and
 * scroll positions jump. Nothing self-corrects it either — re-measuring
 * returns the same margin-less box every time.
 *
 * This is the same trap the "never use `margin` on a `.cm-line`" note in
 * media/webview-editor-theme.css describes, one level further out: it applies
 * to *any* element CodeMirror measures, a block widget's root included.
 *
 * Expressing the gap as `padding` keeps it inside the measured box. A wrapper
 * element (rather than just swapping `margin` for `padding` on the widget
 * itself) is needed because the two table widgets can't carry that padding:
 * CSS ignores `padding` on a `border-collapse: collapse` table. Wrapping keeps
 * the Mermaid toolbar's positioning root (`.mlp-mermaid-wrap`, which is
 * `position: relative`) padding-free too, so its absolute offsets stay put.
 */
export function wrapBlockWidget(inner: HTMLElement): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'mlp-block';
	wrap.appendChild(inner);
	return wrap;
}
