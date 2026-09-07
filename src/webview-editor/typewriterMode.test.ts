import { describe, expect, it } from 'vitest';
import { calculateTypewriterScrollTop, isWritingOrientedKey } from './typewriterMode';

describe('calculateTypewriterScrollTop', () => {
	it('places the caret midpoint at 40% of the viewport', () => {
		expect(
			calculateTypewriterScrollTop({
				currentScrollTop: 100,
				clientHeight: 500,
				scrollHeight: 3000,
				viewportTop: 20,
				caretTop: 470,
				caretBottom: 490,
			}),
		).toBe(360);
	});

	it('clamps at the beginning and end of a document', () => {
		expect(
			calculateTypewriterScrollTop({
				currentScrollTop: 0,
				clientHeight: 500,
				scrollHeight: 3000,
				viewportTop: 0,
				caretTop: 0,
				caretBottom: 20,
			}),
		).toBe(0);
		expect(
			calculateTypewriterScrollTop({
				currentScrollTop: 2500,
				clientHeight: 500,
				scrollHeight: 3000,
				viewportTop: 0,
				caretTop: 490,
				caretBottom: 510,
			}),
		).toBe(2500);
	});

	it('does not move a document that is shorter than its viewport', () => {
		expect(
			calculateTypewriterScrollTop({
				currentScrollTop: 0,
				clientHeight: 500,
				scrollHeight: 480,
				viewportTop: 0,
				caretTop: 300,
				caretBottom: 320,
			}),
		).toBe(0);
	});
});

describe('isWritingOrientedKey', () => {
	it('recognizes text, Enter, and vertical caret movement', () => {
		expect(isWritingOrientedKey({ key: 'a', ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
		expect(isWritingOrientedKey({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
		expect(isWritingOrientedKey({ key: 'ArrowUp', ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
		expect(isWritingOrientedKey({ key: 'ArrowDown', ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
	});

	it('leaves commands and horizontal navigation to ordinary editor behavior', () => {
		expect(isWritingOrientedKey({ key: 'f', ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
		expect(isWritingOrientedKey({ key: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
		expect(isWritingOrientedKey({ key: 'PageDown', ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
	});
});
