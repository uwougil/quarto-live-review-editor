import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The curated language set is spelled out in three places that must agree:
 * CURATED_LANGS in shikiHost.ts (what the highlighter will accept), LANGS in
 * scripts/build-shiki-langs.mjs (what gets written to dist/langs), and the
 * alias map that rewrites "js" to "javascript" and friends.
 *
 * Since grammars stopped being bundled, a mismatch no longer fails the build —
 * it degrades silently to uncolored code for that one language, which is easy
 * to miss. These tests read the two source files and compare them directly.
 */

const root = join(__dirname, '..', '..');

function readSource(relative: string): string {
	return readFileSync(join(root, relative), 'utf8');
}

/** Extracts the quoted names from a `const <name> = [...]` array literal. */
function extractNameList(source: string, declaration: string): string[] {
	const start = source.indexOf(declaration);
	if (start === -1) throw new Error(`could not find "${declaration}"`);
	const open = source.indexOf('[', start);
	const close = source.indexOf(']', open);
	if (open === -1 || close === -1) throw new Error(`could not parse the array after "${declaration}"`);
	return [...source.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const hostSource = readSource('src/editor/shikiHost.ts');
const scriptSource = readSource('scripts/build-shiki-langs.mjs');

const curated = extractNameList(hostSource, 'const CURATED_LANGS');
const generated = extractNameList(scriptSource, 'const LANGS');

describe('curated Shiki languages', () => {
	it('lists the same languages in shikiHost and the generation script', () => {
		expect([...generated].sort()).toEqual([...curated].sort());
	});

	it('has no duplicate entries', () => {
		expect(new Set(curated).size).toBe(curated.length);
	});

	it('resolves every alias to a curated language', () => {
		// A stale alias (e.g. left pointing at a language later dropped from the
		// set) silently disables highlighting for that fence tag.
		const aliasLine = /const LANG_ALIASES[^=]*=\s*\{([^}]*)\}/.exec(hostSource);
		expect(aliasLine).not.toBeNull();
		const targets = [...aliasLine![1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			expect(curated, `alias target "${target}"`).toContain(target);
		}
	});
});

// Grammar files exist only after a build; skipped on a clean checkout rather
// than failing, since `npm test` is expected to pass without one.
const langsDir = join(root, 'dist', 'langs');
const built = existsSync(langsDir);

describe.skipIf(!built)('generated grammar files', () => {
	it('writes one grammar per curated language', () => {
		for (const name of curated) {
			expect(existsSync(join(langsDir, `${name}.json`)), `dist/langs/${name}.json`).toBe(true);
		}
	});

	it('writes each grammar as a non-empty array that answers to the curated name', () => {
		for (const name of curated) {
			const parsed = JSON.parse(readFileSync(join(langsDir, `${name}.json`), 'utf8')) as Array<{
				name: string;
				aliases?: string[];
			}>;
			expect(Array.isArray(parsed), `${name}.json is an array`).toBe(true);
			expect(parsed.length, `${name}.json has entries`).toBeGreaterThan(0);
			// The fence tag we look a grammar up by must be registered, either as a
			// grammar's own name or one of its aliases — `bash.json`, for instance,
			// holds a grammar named "shellscript" that lists bash/sh/zsh as aliases,
			// and shiki registers all of them.
			const registered = new Set(parsed.flatMap((g) => [g.name, ...(g.aliases ?? [])]));
			expect([...registered], `${name}.json registers "${name}"`).toContain(name);
		}
	});
});
