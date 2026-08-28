/**
 * On-demand loader for the Mermaid bundle.
 *
 * Mermaid (with its cytoscape and KaTeX dependencies) is ~2.5MB — over half of
 * what the editor webview used to ship in a single file, parsed on every
 * document open even though most Markdown contains no diagrams at all.
 *
 * `import('mermaid')` alone does not help here: the webview bundle is built as
 * an IIFE (esbuild cannot code-split that format), so a dynamic import is
 * inlined right back into the main file. Mermaid is therefore built as its own
 * entry point (`dist/mermaid-chunk.js`, see esbuild.js) and fetched here by
 * appending a <script> tag the first time a diagram is actually rendered.
 *
 * The tag carries the same nonce as the page's own script: the webview's CSP is
 * `script-src 'nonce-...'`, so an un-nonced tag is blocked outright. Switching
 * the bundle to ESM + splitting would hit exactly that wall — esbuild's
 * generated chunk imports get no nonce — which is why this loads the chunk as a
 * classic script that assigns to `window.mlpMermaid` instead.
 */

/** Shape the chunk publishes on `window`; see webview-mermaid/main.ts. */
export type MermaidApi = typeof import('mermaid')['default'];

declare global {
	interface Window {
		mlpMermaid?: MermaidApi;
		mlpMermaidChunkUri?: string;
		mlpNonce?: string;
	}
}

let loadPromise: Promise<MermaidApi> | null = null;

/**
 * Resolves with Mermaid's default export, loading the chunk on first call and
 * reusing that same promise afterwards. Concurrent callers (several diagrams in
 * one document all rendering at once) share a single <script> insertion.
 */
export function loadMermaidModule(): Promise<MermaidApi> {
	if (loadPromise) return loadPromise;

	loadPromise = new Promise<MermaidApi>((resolve, reject) => {
		// Already present — the chunk was loaded by an earlier editor instance in
		// this same webview, or inlined by a future build.
		if (window.mlpMermaid) {
			resolve(window.mlpMermaid);
			return;
		}

		const src = window.mlpMermaidChunkUri;
		if (!src) {
			reject(new Error('Mermaid chunk URI was not provided by the host'));
			return;
		}

		const script = document.createElement('script');
		script.src = src;
		// Without a matching nonce the webview's CSP blocks this tag silently.
		if (window.mlpNonce) script.nonce = window.mlpNonce;
		script.addEventListener('load', () => {
			if (window.mlpMermaid) resolve(window.mlpMermaid);
			else reject(new Error('Mermaid chunk loaded but did not register itself'));
		});
		script.addEventListener('error', () => reject(new Error('Failed to load the Mermaid bundle')));
		document.head.appendChild(script);
	});

	// A failed load must not poison every later attempt: drop the cached promise
	// so a subsequent diagram (or a retry after a transient failure) can try
	// again, while in-flight callers still see this rejection.
	loadPromise.catch(() => {
		loadPromise = null;
	});

	return loadPromise;
}
