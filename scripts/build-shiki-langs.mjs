/**
 * Writes each curated Shiki grammar to `dist/langs/<name>.json`.
 *
 * The grammars are the bulk of the extension bundle — around 2.5MB of the
 * 2.6MB `dist/extension.js`, with C++ alone accounting for ~680KB — and every
 * one of them was parsed at activation even though a given document typically
 * uses none or one. Emitting them as separate files lets shikiHost.ts read only
 * the languages a document actually fences.
 *
 * They cannot simply be `require`d from node_modules at runtime: `.vscodeignore`
 * keeps `node_modules/**` out of the VSIX, and `@shikijs/langs` is ESM-only, so
 * it is unreachable from the CJS extension bundle either way. Copying the data
 * into `dist/` sidesteps both problems — `dist/` is packaged, and plain JSON
 * needs no module loader.
 *
 * Each grammar file is self-contained: entries like `cpp` and `php` embed the
 * sub-grammars they reference (cpp-macro, sql, ...), so loading one file is
 * always enough to highlight that language.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'langs');

// Keep in sync with CURATED_LANGS in src/editor/shikiHost.ts.
const LANGS = [
	'bash', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript',
	'json', 'jsx', 'kotlin', 'markdown', 'php', 'python', 'ruby', 'rust',
	'shellscript', 'sql', 'swift', 'tsx', 'typescript', 'yaml',
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let total = 0;
for (const name of LANGS) {
	const mod = await import(`@shikijs/langs/${name}`);
	const json = JSON.stringify(mod.default);
	await writeFile(join(outDir, `${name}.json`), json, 'utf8');
	total += Buffer.byteLength(json);
}

console.log(`shiki: wrote ${LANGS.length} grammars (${(total / 1024 / 1024).toFixed(1)}MB) to dist/langs`);
