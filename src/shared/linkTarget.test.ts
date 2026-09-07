import { describe, it, expect } from 'vitest';
import { resolveLinkTarget } from './linkTarget';

describe('resolveLinkTarget', () => {
	describe('links the shell should handle', () => {
		it.each(['https://example.com', 'http://example.com/a?b=1', 'mailto:a@b.c', 'vscode://settings', 'file:///c:/x.md'])(
			'sends %s to the shell unchanged',
			(href) => {
				expect(resolveLinkTarget(href)).toEqual({ kind: 'external', href });
			},
		);
	});

	describe('links relative to the document', () => {
		// The bug this guards: `Uri.parse('./guide.md')` yields a scheme-less URI
		// that resolves against nothing, and the shell was handed a path it could
		// not find — surfacing as a "file not found (0x2)" dialog.
		it.each(['./guide.md', '../notes/a.md', 'guide.md', 'sub/dir/deep.md'])('treats %s as relative', (href) => {
			expect(resolveLinkTarget(href)).toEqual({ kind: 'relative', path: href });
		});

		it('keeps a trailing fragment separate from the filename', () => {
			expect(resolveLinkTarget('guide.md#installation')).toEqual({ kind: 'relative', path: 'guide.md', fragment: 'installation' });
		});

		it('decodes percent-encoding, since the filesystem wants the real name', () => {
			expect(resolveLinkTarget('my%20note.md')).toEqual({ kind: 'relative', path: 'my note.md' });
		});

		it('falls back to the raw path when the escapes are malformed', () => {
			expect(resolveLinkTarget('100%.md')).toEqual({ kind: 'relative', path: '100%.md' });
		});

		// A single letter is never a real scheme, so `C:` must not be mistaken for
		// one — otherwise a Windows absolute path is sent to `Uri.parse`.
		it('does not mistake a Windows drive letter for a scheme', () => {
			const target = resolveLinkTarget('C:/notes/a.md');
			expect(target.kind).toBe('relative');
		});
	});

	describe('links with nothing to open', () => {
		it('returns a fragment-only link as a local navigation target', () => {
			expect(resolveLinkTarget('#heading')).toEqual({ kind: 'fragment', fragment: 'heading' });
		});

		it('decodes a percent-encoded fragment', () => {
			expect(resolveLinkTarget('#Berry%20curvature')).toEqual({ kind: 'fragment', fragment: 'Berry curvature' });
		});

		it.each(['', '   '])('ignores the empty href %o', (href) => {
			expect(resolveLinkTarget(href)).toEqual({ kind: 'ignore' });
		});
	});
});
