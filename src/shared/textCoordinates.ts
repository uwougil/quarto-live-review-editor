/** Canonical text used by the webview. CodeMirror counts every line break as one character. */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?|\n/g, '\n');
}

/** Maps a CodeMirror/LF offset to the equivalent UTF-16 offset in host text. */
export function hostOffsetFromCanonicalOffset(hostText: string, canonicalOffset: number): number {
	const target = Math.max(0, Math.min(canonicalOffset, normalizeLineEndings(hostText).length));
	let hostOffset = 0;
	let canonical = 0;
	while (hostOffset < hostText.length && canonical < target) {
		if (hostText.charCodeAt(hostOffset) === 13 && hostText.charCodeAt(hostOffset + 1) === 10) {
			hostOffset += 2;
		} else {
			hostOffset++;
		}
		canonical++;
	}
	return hostOffset;
}

/** Maps a host UTF-16 offset to the equivalent CodeMirror/LF offset. */
export function canonicalOffsetFromHostOffset(hostText: string, hostOffset: number): number {
	const target = Math.max(0, hostOffset);
	const knownTarget = Math.min(target, hostText.length);
	let raw = 0;
	let canonical = 0;
	while (raw < knownTarget) {
		if (hostText.charCodeAt(raw) === 13 && hostText.charCodeAt(raw + 1) === 10) {
			if (raw + 1 >= knownTarget) break;
			raw += 2;
		} else {
			raw++;
		}
		canonical++;
	}
	// A deliberately delayed event can describe a newer snapshot than the one
	// cached here. Preserve the unknown suffix one-for-one; any CRLF pairs in the
	// known prefix have still been removed correctly.
	return canonical + (target - knownTarget);
}
