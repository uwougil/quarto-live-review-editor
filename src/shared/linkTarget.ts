/**
 * Where a link from the preview should be sent.
 *
 * Deciding this is easy to get wrong in ways that only show up as an OS error
 * dialog, so it is kept apart from the `vscode` API calls that act on it and
 * unit-tested directly.
 */
export type LinkTarget =
	| { kind: 'ignore' }
	/** A fragment-only target inside the current document. */
	| { kind: 'fragment'; fragment: string }
	/** Already carries a scheme (`https:`, `mailto:`, …): hand it to the shell. */
	| { kind: 'external'; href: string }
	/** A path relative to the document's own folder, with an optional fragment. */
	| { kind: 'relative'; path: string; fragment?: string };

/**
 * A scheme is a letter followed by at least one more letter/digit/`+`/`-`/`.`
 * before the colon. Requiring that second character is deliberate: it keeps a
 * Windows drive letter (`C:\notes\a.md`) from being mistaken for a scheme, since
 * a real scheme is never a single character.
 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

export function resolveLinkTarget(href: string): LinkTarget {
	const trimmed = href.trim();
	if (!trimmed) return { kind: 'ignore' };
	if (SCHEME_RE.test(trimmed)) return { kind: 'external', href: trimmed };

	const hash = trimmed.indexOf('#');
	const rawPath = hash === -1 ? trimmed : trimmed.slice(0, hash);
	const rawFragment = hash === -1 ? undefined : trimmed.slice(hash + 1);
	const decode = (value: string): string => {
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	};
	const fragment = rawFragment === undefined ? undefined : decode(rawFragment);
	if (!rawPath) return fragment ? { kind: 'fragment', fragment } : { kind: 'ignore' };
	let path = rawPath;
	try {
		path = decodeURIComponent(rawPath);
	} catch {
		// Malformed escapes (a bare `%` in a filename): use the path as written.
	}
	return fragment ? { kind: 'relative', path, fragment } : { kind: 'relative', path };
}
