/**
 * Fetches the text of a `.drawio` file referenced from the document.
 *
 * The webview has no filesystem access, so a `![](diagram.drawio)` reference has
 * to be read by the host and sent back (see documentSync.ts). This wraps that
 * round-trip in a promise per request.
 *
 * Requests are correlated by an id rather than assuming replies arrive in order:
 * a document can hold several diagrams whose reads are in flight at once, and
 * the host reads them independently, so the second request can easily answer
 * first. Without the id, one diagram would render another one's contents.
 *
 * Results are cached by path so that the same diagram referenced twice, or
 * re-rendered when the widget is rebuilt (which CodeMirror does freely), does
 * not re-read the file each time.
 */
import type { HostToEditorMessage } from '../shared/messages';

type Pending = { resolve: (text: string) => void; reject: (err: Error) => void };

const pending = new Map<number, Pending>();
const cache = new Map<string, Promise<string>>();
let nextRequestId = 1;

/** Set by main.ts so this module does not need its own `acquireVsCodeApi`. */
let post: ((message: unknown) => void) | null = null;

export function setDrawioFilePoster(fn: (message: unknown) => void): void {
	post = fn;
}

/**
 * Handles a `drawioFile` reply. Returns whether the message was one of ours, so
 * the caller's message switch can fall through for anything else.
 */
export function handleDrawioFileMessage(message: HostToEditorMessage): boolean {
	if (message.type !== 'drawioFile') return false;
	const entry = pending.get(message.requestId);
	if (!entry) return true; // a reply for a widget that has since been torn down
	pending.delete(message.requestId);
	if (typeof message.text === 'string') entry.resolve(message.text);
	else entry.reject(new Error(message.error ?? 'ファイルを読み込めませんでした。'));
	return true;
}

/** Resolves with the file's text, reusing an in-flight or completed read. */
export function readDrawioFile(src: string): Promise<string> {
	const cached = cache.get(src);
	if (cached) return cached;

	const promise = new Promise<string>((resolve, reject) => {
		if (!post) {
			reject(new Error('ホストへの接続がまだ確立していません。'));
			return;
		}
		const requestId = nextRequestId++;
		pending.set(requestId, { resolve, reject });
		post({ type: 'readDrawioFile', requestId, src });
	});

	// A failed read must not be cached as the permanent answer: the file may
	// simply not exist yet, and re-rendering after the user creates it should
	// pick it up rather than keep showing the old error.
	promise.catch(() => cache.delete(src));
	cache.set(src, promise);
	return promise;
}

/**
 * Drops a cached file so the next render re-reads it.
 *
 * Called when the host reports the file changed on disk; without it, editing a
 * diagram in the draw.io app would leave the Markdown preview showing the
 * version that was current when the document was opened.
 */
export function invalidateDrawioFile(src: string): void {
	cache.delete(src);
}

/** Clears every cached read — used when the document itself is re-initialised. */
export function clearDrawioFileCache(): void {
	cache.clear();
}

/** Whether a Markdown image path should be rendered as a draw.io diagram. */
export function isDrawioPath(src: string): boolean {
	// `.drawio.svg` and `.drawio.png` are draw.io's "editable export" formats:
	// they are real SVG/PNG that an <img> renders perfectly well on its own, with
	// the diagram source merely embedded for round-tripping. Only the bare
	// `.drawio`/`.dio` XML needs to come through this path.
	const path = src.split(/[?#]/)[0].toLowerCase();
	return path.endsWith('.drawio') || path.endsWith('.dio') || path.endsWith('.drawio.xml');
}
