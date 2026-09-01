/**
 * On-demand loader for the AWS architecture shape table.
 *
 * `dist/aws4-shapes.json` is ~2.3MB — larger than the editor bundle itself —
 * and a document with no AWS diagram never needs a byte of it, so it is fetched
 * only when a diagram actually references one of these shapes. The host hands
 * over the URI (only host-side code can call `asWebviewUri`), the same
 * arrangement the Mermaid chunk uses.
 *
 * Unlike the Mermaid chunk this is plain data, so it can be fetched rather than
 * injected as a <script>: the webview's CSP allows `fetch` back to
 * `webview.cspSource`, and data needs no nonce.
 */

/** One shape's native box and its SVG path data. */
export interface AwsShape {
	w: number;
	h: number;
	d: string;
}

declare global {
	interface Window {
		mlpAwsShapesUri?: string;
	}
}

let shapes: Record<string, AwsShape> | null = null;
let loadPromise: Promise<Record<string, AwsShape>> | null = null;

/**
 * The shape prefix draw.io writes for this library. A style names a shape as
 * `mxgraph.aws4.ec2`; the table is keyed by the bare `ec2`.
 */
const AWS4_PREFIX = 'mxgraph.aws4.';

/** Strips the library prefix, or returns null if this is not an AWS4 shape. */
export function awsShapeKey(name: string | undefined): string | null {
	if (!name) return null;
	const trimmed = name.trim();
	if (!trimmed.toLowerCase().startsWith(AWS4_PREFIX)) return null;
	return trimmed.slice(AWS4_PREFIX.length).toLowerCase();
}

/**
 * Resolves with the shape table, fetching it once and reusing that promise.
 *
 * A failed load drops the cached promise so a later diagram can retry, rather
 * than every AWS diagram in the session inheriting one transient failure.
 */
export function loadAwsShapes(): Promise<Record<string, AwsShape>> {
	if (loadPromise) return loadPromise;

	loadPromise = (async () => {
		const src = window.mlpAwsShapesUri;
		if (!src) throw new Error('AWS shape table URI was not provided by the host');
		const response = await fetch(src);
		if (!response.ok) throw new Error(`Failed to load the AWS shape table (${response.status})`);
		const data = (await response.json()) as Record<string, AwsShape>;
		shapes = data;
		return data;
	})();

	loadPromise.catch(() => {
		loadPromise = null;
	});
	return loadPromise;
}

/**
 * Returns a shape if the table is already loaded, else null.
 *
 * The renderer is synchronous — it builds an SVG string in one pass — so it
 * cannot await the table. It draws the plain coloured tile on the first pass and
 * re-renders once `loadAwsShapes` resolves, which is why this never triggers a
 * load itself.
 */
export function getLoadedAwsShape(key: string): AwsShape | null {
	return shapes?.[key] ?? null;
}

/** Whether the table is in memory, so a caller can decide to re-render. */
export function awsShapesReady(): boolean {
	return shapes !== null;
}

/** Test seam: installs a table directly, bypassing the fetch. */
export function setAwsShapesForTest(table: Record<string, AwsShape> | null): void {
	shapes = table;
	loadPromise = null;
}
