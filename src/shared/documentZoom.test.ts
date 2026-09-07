import { describe, expect, it } from 'vitest';
import {
	adjustDocumentZoom,
	DOCUMENT_ZOOM_DEFAULT,
	DOCUMENT_ZOOM_MAX,
	DOCUMENT_ZOOM_MIN,
	DOCUMENT_ZOOM_STEP,
	normalizeDocumentZoom,
} from './documentZoom';
import { wheelZoomSteps, zoomKeyAction } from '../webview-editor/documentZoom';

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

describe('document zoom input mapping', () => {
	it('maps wheel direction and ignores a zero delta', () => {
		expect(wheelZoomSteps(-1)).toBe(1);
		expect(wheelZoomSteps(1)).toBe(-1);
		expect(wheelZoomSteps(0)).toBe(0);
	});

	it('uses Ctrl on Windows/Linux and Cmd on macOS', () => {
		expect(zoomKeyAction({ key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false }, 'Win32')).toBe('increase');
		expect(zoomKeyAction({ key: '-', code: 'Minus', ctrlKey: true, metaKey: false, altKey: false }, 'Linux')).toBe('decrease');
		expect(zoomKeyAction({ key: '0', code: 'Digit0', ctrlKey: false, metaKey: true, altKey: false }, 'MacIntel')).toBe('reset');
		expect(zoomKeyAction({ key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false }, 'MacIntel')).toBeNull();
	});

	it('recognizes numpad shortcuts and does not claim modified alternatives', () => {
		expect(zoomKeyAction({ key: 'Add', code: 'NumpadAdd', ctrlKey: true, metaKey: false, altKey: false }, 'Win32')).toBe('increase');
		expect(zoomKeyAction({ key: 'Subtract', code: 'NumpadSubtract', ctrlKey: true, metaKey: false, altKey: false }, 'Win32')).toBe('decrease');
		expect(zoomKeyAction({ key: '0', code: 'Numpad0', ctrlKey: true, metaKey: false, altKey: true }, 'Win32')).toBeNull();
		expect(zoomKeyAction({ key: 'a', code: 'KeyA', ctrlKey: true, metaKey: false, altKey: false }, 'Win32')).toBeNull();
	});
});
