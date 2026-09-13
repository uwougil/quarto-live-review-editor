import { describe, expect, it } from 'vitest';
import { normalizeMathDelimitersWithMetadata } from '../quarto/normalizeMathDelimiters';
import { formatNormalizedMathPaste } from './mathPasteHandler';

function format(documentText: string, from: number, to = from, pasted = '\\[E\\]'): string {
	return formatNormalizedMathPaste(documentText, from, to, normalizeMathDelimitersWithMetadata(pasted));
}

describe('formatNormalizedMathPaste', () => {
	it('isolates display math pasted into the middle of a prose line', () => {
		const documentText = 'foo HERE bar';
		const position = documentText.indexOf('HERE');
		expect(format(documentText, position, position + 4)).toBe('\n$$\nE\n$$\n');
	});

	it('adds only the needed side at a line start or line end', () => {
		expect(format('HERE bar', 0)).toBe('$$\nE\n$$\n');
		expect(format('foo ', 4)).toBe('\n$$\nE\n$$');
	});

	it('does not add blank lines on an empty line or next to newlines', () => {
		const documentText = 'before\n\nafter';
		const position = 'before\n'.length;
		expect(format(documentText, position)).toBe('$$\nE\n$$');
	});

	it('uses CRLF for destination-context and generated display lines', () => {
		const documentText = 'foo HERE bar\r\n';
		const position = documentText.indexOf('HERE');
		expect(format(documentText, position, position + 4)).toBe('\r\n$$\r\nE\r\n$$\r\n');
	});

	it('leaves inline normalization unchanged by destination formatting', () => {
		const pasted = '\\( E = mc^2 \\)';
		const normalized = normalizeMathDelimitersWithMetadata(pasted);
		expect(formatNormalizedMathPaste('foo HERE bar', 4, 8, normalized)).toBe('$ E = mc^2 $');
	});
});
