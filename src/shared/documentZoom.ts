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

/** Reading-column width as a percentage of a theme's own finite baseline. */
export const READING_WIDTH_MIN = 60;
export const READING_WIDTH_MAX = 180;
export const READING_WIDTH_DEFAULT = 100;
export const READING_WIDTH_STEP = 10;
export const READING_WIDTH_FULL = 'full' as const;
export type ReadingWidthState = number | typeof READING_WIDTH_FULL;

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

/** Normalizes persisted or message-supplied reading width to its step grid. */
export function normalizeReadingWidth(value: unknown): ReadingWidthState {
	if (value === READING_WIDTH_FULL) return READING_WIDTH_FULL;
	if (typeof value !== 'number' || !Number.isFinite(value)) return READING_WIDTH_DEFAULT;
	const stepped = Math.round(value / READING_WIDTH_STEP) * READING_WIDTH_STEP;
	return Math.min(READING_WIDTH_MAX, Math.max(READING_WIDTH_MIN, stepped));
}

/** Applies signed 10% steps, entering Full after 180% and leaving it at 180%. */
export function adjustReadingWidth(current: unknown, steps: number): ReadingWidthState {
	const base = normalizeReadingWidth(current);
	if (!Number.isFinite(steps) || steps === 0) return base;
	const delta = Math.trunc(steps) * READING_WIDTH_STEP;
	if (base === READING_WIDTH_FULL) {
		if (delta >= 0) return READING_WIDTH_FULL;
		return normalizeReadingWidth(READING_WIDTH_MAX + delta + READING_WIDTH_STEP);
	}
	const next = base + delta;
	return next > READING_WIDTH_MAX ? READING_WIDTH_FULL : normalizeReadingWidth(next);
}
