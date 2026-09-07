/**
 * Zoom for the Markdown/Quarto document inside a Live Preview editor.
 *
 * This is intentionally separate from VS Code's global zoom. Keeping the
 * value as a percentage also makes the persisted representation independent of
 * the editor font size supplied by VS Code.
 */
export const DOCUMENT_ZOOM_MIN = 70;
export const DOCUMENT_ZOOM_MAX = 200;
export const DOCUMENT_ZOOM_DEFAULT = 100;
export const DOCUMENT_ZOOM_STEP = 10;

/** Normalizes persisted or message-supplied zoom to the supported step grid. */
export function normalizeDocumentZoom(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DOCUMENT_ZOOM_DEFAULT;
	const stepped = Math.round(value / DOCUMENT_ZOOM_STEP) * DOCUMENT_ZOOM_STEP;
	return Math.min(DOCUMENT_ZOOM_MAX, Math.max(DOCUMENT_ZOOM_MIN, stepped));
}

/** Applies a signed number of 10% steps while preserving the hard bounds. */
export function adjustDocumentZoom(current: unknown, steps: number): number {
	const base = normalizeDocumentZoom(current);
	if (!Number.isFinite(steps) || steps === 0) return base;
	return normalizeDocumentZoom(base + Math.trunc(steps) * DOCUMENT_ZOOM_STEP);
}
