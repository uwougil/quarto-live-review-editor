import { describe, expect, it } from 'vitest';
import {
	canonicalOffsetFromHostOffset,
	hostOffsetFromCanonicalOffset,
	normalizeLineEndings,
} from './textCoordinates';

describe('text coordinate conversion', () => {
	it('normalizes CRLF and lone CR without changing ordinary text', () => {
		expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
	});

	it('maps every LF document boundary to and from CRLF host offsets', () => {
		const host = 'a\r\nbc\r\nd';
		const hostOffsets = [0, 1, 3, 4, 5, 7, 8];
		for (let canonical = 0; canonical < hostOffsets.length; canonical++) {
			expect(hostOffsetFromCanonicalOffset(host, canonical)).toBe(hostOffsets[canonical]);
			expect(canonicalOffsetFromHostOffset(host, hostOffsets[canonical])).toBe(canonical);
		}
	});
});
