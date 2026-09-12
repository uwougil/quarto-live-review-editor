import { describe, expect, it } from 'vitest';
import {
	adjustDocumentZoom,
	DOCUMENT_ZOOM_DEFAULT,
	DOCUMENT_ZOOM_MAX,
	DOCUMENT_ZOOM_MIN,
	DOCUMENT_ZOOM_STEP,
	normalizeDocumentZoom,
	adjustReadingWidth,
	READING_WIDTH_DEFAULT,
	READING_WIDTH_FULL,
	READING_WIDTH_MAX,
	READING_WIDTH_MIN,
	READING_WIDTH_STEP,
	normalizeReadingWidth,
} from './documentZoom';
import {
	adjustReadingWidthForVisualGeometry,
	wheelZoomSteps,
	zoomKeyAction,
	type ReadingWidthGeometry,
} from '../webview-editor/documentZoom';

describe('document zoom values', () => {
	it('starts at 100% and normalizes malformed persisted values', () => {
		expect(normalizeDocumentZoom(undefined)).toBe(DOCUMENT_ZOOM_DEFAULT);
		expect(normalizeDocumentZoom(Number.NaN)).toBe(DOCUMENT_ZOOM_DEFAULT);
		expect(normalizeDocumentZoom(75)).toBe(80);
		expect(normalizeDocumentZoom(65)).toBe(DOCUMENT_ZOOM_MIN);
		expect(normalizeDocumentZoom(205)).toBe(DOCUMENT_ZOOM_MAX);
	});

	it('changes in 10% steps and stays at both boundaries', () => {
		expect(adjustDocumentZoom(DOCUMENT_ZOOM_DEFAULT, 1)).toBe(DOCUMENT_ZOOM_DEFAULT + DOCUMENT_ZOOM_STEP);
		expect(adjustDocumentZoom(DOCUMENT_ZOOM_DEFAULT, -1)).toBe(DOCUMENT_ZOOM_DEFAULT - DOCUMENT_ZOOM_STEP);
		expect(adjustDocumentZoom(DOCUMENT_ZOOM_MIN, -1)).toBe(DOCUMENT_ZOOM_MIN);
		expect(adjustDocumentZoom(DOCUMENT_ZOOM_MAX, 1)).toBe(DOCUMENT_ZOOM_MAX);
	});
});

describe('reading width values', () => {
	it('starts at 100% and normalizes malformed or out-of-range values', () => {
		expect(normalizeReadingWidth(undefined)).toBe(READING_WIDTH_DEFAULT);
		expect(normalizeReadingWidth(Number.NaN)).toBe(READING_WIDTH_DEFAULT);
		expect(normalizeReadingWidth(75)).toBe(80);
		expect(normalizeReadingWidth(55)).toBe(READING_WIDTH_MIN);
		expect(normalizeReadingWidth(325)).toBe(READING_WIDTH_MAX);
		expect(normalizeReadingWidth(READING_WIDTH_FULL)).toBe(READING_WIDTH_FULL);
	});

	it('changes in 10% steps, enters Full, and leaves Full at 320%', () => {
		expect(adjustReadingWidth(READING_WIDTH_DEFAULT, 1)).toBe(READING_WIDTH_DEFAULT + READING_WIDTH_STEP);
		expect(adjustReadingWidth(READING_WIDTH_DEFAULT, -1)).toBe(READING_WIDTH_DEFAULT - READING_WIDTH_STEP);
		expect(adjustReadingWidth(READING_WIDTH_MIN, -1)).toBe(READING_WIDTH_MIN);
		expect(adjustReadingWidth(310, 1)).toBe(READING_WIDTH_MAX);
		expect(adjustReadingWidth(READING_WIDTH_MAX, 1)).toBe(READING_WIDTH_FULL);
		expect(adjustReadingWidth(READING_WIDTH_FULL, -1)).toBe(READING_WIDTH_MAX);
		expect(adjustReadingWidth(READING_WIDTH_FULL, -2)).toBe(310);
		expect(adjustReadingWidth(READING_WIDTH_FULL, 1)).toBe(READING_WIDTH_FULL);
	});

	it('enters Full before invisible finite-width steps and shrinks immediately from Full', () => {
		const probe = (state: number | typeof READING_WIDTH_FULL): ReadingWidthGeometry => {
			if (state === READING_WIDTH_FULL) return { width: 2000, maxWidth: 'none' };
			const finiteWidth = state * 9.8;
			return {
				width: Math.min(finiteWidth, 2000),
				maxWidth: `${finiteWidth}px`,
			};
		};

		expect(adjustReadingWidthForVisualGeometry(190, 1, probe)).toBe(200);
		// 210% would already be clipped to the same width as Full, so the user
		// should enter Full now instead of accumulating 210…320% invisible steps.
		expect(adjustReadingWidthForVisualGeometry(200, 1, probe)).toBe(READING_WIDTH_FULL);
		// One decrement from Full must visibly narrow the document again.
		expect(adjustReadingWidthForVisualGeometry(READING_WIDTH_FULL, -1, probe)).toBe(200);
		// A persisted/remote overshoot is collapsed on the first decrement too.
		expect(adjustReadingWidthForVisualGeometry(READING_WIDTH_MAX, -1, probe)).toBe(200);
	});

	it('keeps numeric stepping for unsupported width rules that do not respond to the scale variable', () => {
		const probe = (_state: number | typeof READING_WIDTH_FULL): ReadingWidthGeometry => ({
			width: 900,
			maxWidth: '100%',
		});
		expect(adjustReadingWidthForVisualGeometry(200, 1, probe)).toBe(210);
		expect(adjustReadingWidthForVisualGeometry(READING_WIDTH_FULL, -1, probe)).toBe(READING_WIDTH_MAX);
	});

	it('does not accumulate hidden decrements when even 60% cannot fit the viewport', () => {
		const probe = (state: number | typeof READING_WIDTH_FULL): ReadingWidthGeometry => {
			if (state === READING_WIDTH_FULL) return { width: 500, maxWidth: 'none' };
			return { width: 500, maxWidth: `${state * 10}px` };
		};
		expect(adjustReadingWidthForVisualGeometry(READING_WIDTH_FULL, -1, probe)).toBe(READING_WIDTH_FULL);
		expect(adjustReadingWidthForVisualGeometry(300, -1, probe)).toBe(300);
	});
});

describe('document zoom input mapping', () => {
	it('maps wheel direction and ignores a zero delta', () => {
		expect(wheelZoomSteps(-1)).toBe(1);
		expect(wheelZoomSteps(1)).toBe(-1);
		expect(wheelZoomSteps(0)).toBe(0);
	});

	it('uses Ctrl on Windows/Linux and Cmd on macOS', () => {
		expect(zoomKeyAction({ key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false }, 'Win32')).toBe('increaseWidth');
		expect(zoomKeyAction({ key: '-', code: 'Minus', ctrlKey: true, metaKey: false, altKey: false }, 'Linux')).toBe('decreaseWidth');
		expect(zoomKeyAction({ key: '0', code: 'Digit0', ctrlKey: false, metaKey: true, altKey: false }, 'MacIntel')).toBe('reset');
		expect(zoomKeyAction({ key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false }, 'MacIntel')).toBeNull();
	});

	it('recognizes numpad shortcuts and does not claim modified alternatives', () => {
		expect(zoomKeyAction({ key: 'Add', code: 'NumpadAdd', ctrlKey: true, metaKey: false, altKey: false }, 'Win32')).toBe('increaseWidth');
		expect(zoomKeyAction({ key: 'Subtract', code: 'NumpadSubtract', ctrlKey: true, metaKey: false, altKey: false }, 'Win32')).toBe('decreaseWidth');
		expect(zoomKeyAction({ key: '0', code: 'Numpad0', ctrlKey: true, metaKey: false, altKey: true }, 'Win32')).toBeNull();
		expect(zoomKeyAction({ key: 'a', code: 'KeyA', ctrlKey: true, metaKey: false, altKey: false }, 'Win32')).toBeNull();
	});

	it('assigns plus and minus to reading width, with an independent width reset', () => {
		expect(zoomKeyAction({ key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, 'Win32')).toBe('increaseWidth');
		expect(zoomKeyAction({ key: '-', code: 'Minus', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 'Win32')).toBe('decreaseWidth');
		expect(zoomKeyAction({ key: ')', code: 'Digit0', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, 'Win32')).toBe('resetWidth');
		expect(zoomKeyAction({ key: '0', code: 'Digit0', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 'Win32')).toBe('reset');
	});
});
