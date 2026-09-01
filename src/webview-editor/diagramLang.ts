/**
 * The single source of truth for "which fence languages render as a diagram".
 *
 * Two places have to agree on this exactly:
 *
 *  - `blockDecorations.ts` decides whether to *replace* the fence with a widget;
 *  - `livePreviewPlugin.ts` decides whether to *style* the fence as a code block.
 *
 * If they disagree, one of two visible faults follows: the fence gets both a
 * line decoration and a block-replacing one, and CodeMirror silently drops the
 * widget (the diagram never appears), or the fence is styled as a code box
 * underneath the rendered diagram. Keeping the test in one function rather than
 * duplicating a string comparison in both files is what stops them drifting.
 */

/** Which renderer a fence language maps to, or `null` for a plain code block. */
export type DiagramKind = 'mermaid' | 'drawio';

/**
 * `drawio` and `xml` are *not* interchangeable: a fence tagged `xml` is ordinary
 * XML the author wants shown as code, so only the explicit draw.io tags render
 * as a diagram. `diagrams.net` is accepted as the tool's current name.
 */
const DRAWIO_LANGS = new Set(['drawio', 'diagrams.net', 'diagramsnet', 'mxgraph']);

export function isDiagramLang(lang: string): DiagramKind | null {
	if (lang === 'mermaid') return 'mermaid';
	if (DRAWIO_LANGS.has(lang)) return 'drawio';
	return null;
}
