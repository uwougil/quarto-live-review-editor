/**
 * Where a link from the preview should be sent.
 *
 * Deciding this is easy to get wrong in ways that only show up as an OS error
 * dialog, so it is kept apart from the `vscode` API calls that act on it and
 * unit-tested directly.
 */
export type LinkTarget =
	/** Nothing to open — a `#heading` link points inside this document. */
	| { kind: 'ignore' }
	/** Already carries a scheme (`https:`, `mailto:`, …): hand it to the shell. */
	| { kind: 'external'; href: string }
	/** A path relative to the document's own folder, with its fragment removed. */
	| { kind: 'relative'; path: string };

/**
 * A scheme is a letter followed by at least one more letter/digit/`+`/`-`/`.`
 * before the colon. Requiring that second character is deliberate: it keeps a
 * Windows drive letter (`C:\notes\a.md`) from being mistaken for a scheme, since
 * a real scheme is never a single character.
 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

export function resolveLinkTarget(href: string): LinkTarget {
	const trimmed = href.trim();
	if (!trimmed || trimmed.startsWith('#')) return { kind: 'ignore' };
	if (SCHEME_RE.test(trimmed)) return { kind: 'external', href: trimmed };

	// Drop a trailing `#fragment` so it cannot end up inside the filename, and
	// undo percent-encoding — a Markdown link to a file whose name contains a
	// space is normally written `my%20note.md`, and the filesystem wants the
	// space back.
	const hash = trimmed.indexOf('#');
	const rawPath = hash === -1 ? trimmed : trimmed.slice(0, hash);
	if (!rawPath) return { kind: 'ignore' };
	let path = rawPath;
	try {
		path = decodeURIComponent(rawPath);
	} catch {
		// Malformed escapes (a bare `%` in a filename): use the path as written.
	}
	return { kind: 'relative', path };
}
