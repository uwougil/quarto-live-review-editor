import * as vscode from 'vscode';
import { createHighlighterCore, type HighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import githubDark from '@shikijs/themes/github-dark';
import githubLight from '@shikijs/themes/github-light';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LanguageRegistration } from '@shikijs/types';
import type { CodeBlockTokens } from '../shared/messages';
import { findFenceBlocks } from '../quarto/fence';

// VS Code's own built-in default themes (Dark+ / Light+), so highlighted code
// matches the colors of the editor next to it out of the box.
const DEFAULT_LIGHT_THEME = 'light-plus';
const DEFAULT_DARK_THEME = 'dark-plus';

// Curated set, kept deliberately small rather than shiki's full ~200-language
// registry. Fenced code in a language outside this list renders without color
// (a documented MVP limitation).
//
// These used to be static imports, which put every grammar in the extension
// bundle: ~2.5MB of the 2.6MB `dist/extension.js`, parsed at activation even
// though a document typically fences none of them or one. They are now written
// to `dist/langs/<name>.json` at build time (scripts/build-shiki-langs.mjs) and
// read here only when a document actually uses that language.
//
// Reading from `dist/` rather than requiring `@shikijs/langs` directly is
// forced: `.vscodeignore` keeps `node_modules/**` out of the VSIX, and the
// package is ESM-only so the CJS extension bundle could not require it anyway.
const CURATED_LANGS = [
	'bash', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript',
	'json', 'jsx', 'kotlin', 'markdown', 'php', 'python', 'ruby', 'rust',
	'shellscript', 'sql', 'swift', 'tsx', 'typescript', 'yaml',
] as const;

const CURATED_LANG_SET: ReadonlySet<string> = new Set(CURATED_LANGS);
const LANG_ALIASES: Record<string, string> = { sh: 'shellscript', shell: 'shellscript', js: 'javascript', ts: 'typescript', 'c++': 'cpp', 'c#': 'csharp', yml: 'yaml', md: 'markdown' };

let highlighterPromise: Promise<HighlighterCore> | null = null;
/** Directory holding the generated grammar JSON; set once at activation. */
let langsDir: string | null = null;
/** Grammars already handed to the highlighter, plus in-flight loads, keyed by
 * language name so repeated fences in one document load a grammar only once. */
const loadedLangs = new Map<string, Promise<boolean>>();

/**
 * Records where the generated grammars live. Called once from `activate` —
 * `shikiHost` has no access to the extension context on its own, and the path
 * differs between a packaged install and a debug session.
 */
export function setGrammarRoot(extensionPath: string): void {
	langsDir = path.join(extensionPath, 'dist', 'langs');
}

async function getHighlighter(): Promise<HighlighterCore> {
	if (!highlighterPromise) {
		// Starts with no grammars at all; `ensureLang` adds them on demand. The
		// themes stay bundled — all four together are ~45KB, small enough that
		// splitting them would cost more in complexity than it saves.
		highlighterPromise = createHighlighterCore({
			themes: [darkPlus, lightPlus, githubDark, githubLight],
			langs: [],
			engine: createJavaScriptRegexEngine(),
		});
	}
	return highlighterPromise;
}

/**
 * Makes `lang` available to the highlighter, reading its grammar from disk the
 * first time it is needed. Resolves to false when the language is outside the
 * curated set or its grammar could not be read, in which case the caller leaves
 * that fence uncolored rather than failing the whole document.
 */
async function ensureLang(highlighter: HighlighterCore, lang: string): Promise<boolean> {
	if (!CURATED_LANG_SET.has(lang)) return false;

	const existing = loadedLangs.get(lang);
	if (existing) return existing;

	const load = (async () => {
		if (!langsDir) return false;
		try {
			const raw = await fs.readFile(path.join(langsDir, `${lang}.json`), 'utf8');
			// Each file is a self-contained array: grammars like cpp and php embed
			// the sub-grammars they reference, so one file is always enough.
			const grammars = JSON.parse(raw) as LanguageRegistration[];
			await highlighter.loadLanguage(...grammars);
			return true;
		} catch {
			// A missing or malformed grammar file degrades to plain uncolored code.
			return false;
		}
	})();

	loadedLangs.set(lang, load);
	// A failed read shouldn't be cached forever, but retrying per fence would
	// hammer the disk for a genuinely absent file; the entry is dropped only if
	// the load rejected outright, which the catch above already prevents.
	return load;
}

function normalizeLang(lang: string): string {
	const lower = lang.trim().toLowerCase();
	return LANG_ALIASES[lower] ?? lower;
}

export function pickCodeTheme(): string {
	const configured = vscode.workspace.getConfiguration('mdLivePreview').get<string>('codeTheme', 'auto');
	if (configured && configured !== 'auto') {
		return configured;
	}
	const kind = vscode.window.activeColorTheme.kind;
	const isLight = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
	return isLight ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME;
}

export async function tokenizeDocument(document: vscode.TextDocument): Promise<CodeBlockTokens[]> {
	const fences = findFenceBlocks(document.getText());
	if (fences.length === 0) {
		return [];
	}

	const highlighter = await getHighlighter();
	const theme = pickCodeTheme();
	const results: CodeBlockTokens[] = [];

	for (const fence of fences) {
		const lang = normalizeLang(fence.info.language ?? '');
		if (!lang || !(await ensureLang(highlighter, lang))) {
			continue;
		}

		const lines: string[] = [];
		for (let li = fence.openingLine + 1; li < fence.closingLine; li++) {
			lines.push(document.lineAt(li).text);
		}
		const code = lines.join('\n');

		let tokenLines;
		try {
			tokenLines = highlighter.codeToTokensBase(code, { lang, theme });
		} catch {
			continue;
		}

		const tokens: CodeBlockTokens['tokens'] = [];
		for (let li = 0; li < tokenLines.length; li++) {
			let col = 0;
			for (const token of tokenLines[li]) {
				if (token.content.length > 0) {
					const startPos = new vscode.Position(fence.openingLine + 1 + li, col);
					const endPos = new vscode.Position(fence.openingLine + 1 + li, col + token.content.length);
					const styleParts = [`color:${token.color ?? '#999999'}`];
					const fontStyle = token.fontStyle ?? 0;
					if (fontStyle & 1) styleParts.push('font-style:italic');
					if (fontStyle & 2) styleParts.push('font-weight:bold');
					if (fontStyle & 4) styleParts.push('text-decoration:underline');
					tokens.push({
						from: document.offsetAt(startPos),
						to: document.offsetAt(endPos),
						style: styleParts.join(';'),
					});
				}
				col += token.content.length;
			}
		}

		results.push({ from: fence.from, to: fence.to, tokens });
	}

	return results;
}
