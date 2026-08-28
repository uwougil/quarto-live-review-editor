/**
 * Entry point for the separately-built Mermaid bundle (`dist/mermaid-chunk.js`).
 *
 * Loaded on demand by mermaidLoader.ts as a classic <script>, so it publishes
 * Mermaid on `window` rather than exporting it: a nonce'd classic script is the
 * one form the editor webview's CSP (`script-src 'nonce-...'`) admits without
 * loosening the policy.
 */
import mermaid from 'mermaid';

window.mlpMermaid = mermaid;
