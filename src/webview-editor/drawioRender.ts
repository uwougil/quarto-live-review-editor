/**
 * Turns draw.io XML into SVG inside the webview.
 *
 * The parsing and drawing live in `shared/drawio*.ts` and are deliberately
 * DOM-free so they can be unit-tested under Node. This module is the thin layer
 * that supplies what only the webview has: a real `DOMParser`, and the VS Code
 * colour theme the diagram should adopt when the document does not specify its
 * own colours.
 *
 * Unlike Mermaid, this needs no separately-loaded bundle — the renderer is a few
 * kilobytes of our own code with no dependencies, so it is bundled directly into
 * the editor webview rather than fetched on demand.
 */
import { buildDiagram, DrawioUnsupportedError, type DrawioDiagram, type XmlElement } from '../shared/drawio';
import { renderDiagramSvg, DARK_THEME, LIGHT_THEME } from '../shared/drawioSvg';
import { getLoadedAwsShape, loadAwsShapes, awsShapesReady } from './awsShapes';

/**
 * Adapts a live DOM `Element` to the minimal `XmlElement` the parser consumes.
 *
 * `childElements` filters to element nodes because `childNodes` also carries the
 * whitespace text nodes between tags, which the parser would then walk for no
 * reason. The wrapper is created lazily per access rather than eagerly for the
 * whole tree, so a large diagram costs nothing for the branches never visited.
 */
function wrapElement(el: Element): XmlElement {
	return {
		get tagName() {
			return el.tagName;
		},
		getAttribute: (name: string) => el.getAttribute(name),
		get childElements() {
			return Array.from(el.children).map(wrapElement);
		},
		get textContent() {
			return el.textContent ?? '';
		},
	};
}

/** Raised when the XML itself will not parse. */
export class DrawioParseError extends Error {}

/**
 * Parses draw.io XML using the webview's own `DOMParser`.
 *
 * `DOMParser` does not throw on malformed input — it returns a document whose
 * body is a `<parsererror>` element instead — so that has to be detected
 * explicitly, or a broken file renders as a blank diagram with no explanation.
 */
export function parseDrawioXml(xml: string): DrawioDiagram {
	const doc = new DOMParser().parseFromString(xml, 'text/xml');
	const failure = doc.querySelector('parsererror');
	if (failure) {
		throw new DrawioParseError('无法解析 XML，请检查 draw.io 文件内容。');
	}
	const root = doc.documentElement;
	if (!root) throw new DrawioParseError('XML 内容为空。');
	return buildDiagram(wrapElement(root));
}

/** Whether the webview is currently showing a dark VS Code theme. */
export function isDarkTheme(): boolean {
	return (
		document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')
	);
}

let uidCounter = 0;

/**
 * Parses and renders draw.io XML to an SVG string.
 *
 * Each call takes a fresh `uid` so that two diagrams in one document cannot
 * collide over their SVG marker ids — those share a single namespace across the
 * whole page, and a collision makes the second diagram's arrowheads vanish the
 * moment the first diagram is edited away.
 */
export function renderDrawioSvg(xml: string, pageIndex = 0): string {
	const diagram = parseDrawioXml(xml);
	const theme = isDarkTheme() ? DARK_THEME : LIGHT_THEME;
	return renderDiagramSvg(diagram, theme, `d${uidCounter++}`, pageIndex);
}

/** Parses without rendering, for callers that need the page list first. */
export function parseDrawioPages(xml: string): DrawioDiagram {
	return parseDrawioXml(xml);
}

/** Renders an already-parsed diagram, reusing the page list across page switches. */
export function renderParsedDiagram(diagram: DrawioDiagram, pageIndex: number): string {
	const theme = isDarkTheme() ? DARK_THEME : LIGHT_THEME;
	return renderDiagramSvg(diagram, theme, `d${uidCounter++}`, pageIndex, getLoadedAwsShape);
}

/**
 * Whether a diagram uses AWS architecture shapes.
 *
 * Used to decide whether the (multi-megabyte) shape table is worth fetching for
 * this document at all — most diagrams do not use them.
 */
export function usesAwsShapes(diagram: DrawioDiagram): boolean {
	for (const page of diagram.pages) {
		for (const shape of page.shapes) {
			if (shape.kind !== 'vertex') continue;
			for (const key of ['resicon', 'gricon', 'shape'] as const) {
				if (shape.style.get(key)?.toLowerCase().startsWith('mxgraph.aws4.')) return true;
			}
		}
	}
	return false;
}

/**
 * Ensures the AWS shape table is loaded, then invokes `onReady` so the caller
 * can re-render with the real symbols.
 *
 * Rendering is synchronous, so a diagram is drawn once with plain coloured tiles
 * and redrawn when the table arrives. `onReady` is skipped when the table was
 * already in memory — the first render used it, and a redraw would only make the
 * widget flicker.
 */
export function ensureAwsShapes(onReady: () => void): void {
	if (awsShapesReady()) return;
	loadAwsShapes().then(onReady, () => {
		// A failed load leaves the plain tiles in place, which is the same thing
		// the user saw before this feature existed — not worth an error message.
	});
}

export { DrawioUnsupportedError };
