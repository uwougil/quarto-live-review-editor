#!/usr/bin/env node

/** Real-Chromium KaTeX font, theme, zoom, geometry and locality regression. */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function insideRepo(candidate) {
	const relative = path.relative(REPO, candidate);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function mimeType(filePath) {
	return {
		'.css': 'text/css; charset=utf-8',
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.woff2': 'font/woff2',
		'.woff': 'font/woff',
		'.ttf': 'font/ttf',
	}[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createServer() {
	return http.createServer(async (request, response) => {
		try {
			const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
			const candidate = path.resolve(REPO, '.' + decodeURIComponent(requestUrl.pathname));
			if (!insideRepo(candidate)) {
				response.writeHead(403); response.end('forbidden'); return;
			}
			const contents = await fs.readFile(candidate);
			response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mimeType(candidate) });
			response.end(contents);
		} catch (error) {
			const status = error?.code === 'ENOENT' ? 404 : 500;
			response.writeHead(status); response.end(status === 404 ? 'not found' : String(error));
		}
	});
}

function assert(condition, message, details = {}) {
	if (!condition) throw new Error(JSON.stringify({ message, ...details }));
}

const requiredFaces = [
	['400 16px "KaTeX_AMS"', 'ℤ'],
	['400 16px "KaTeX_Caligraphic"', 'C'],
	['700 16px "KaTeX_Caligraphic"', 'C'],
	['400 16px "KaTeX_Fraktur"', 'F'],
	['700 16px "KaTeX_Fraktur"', 'F'],
	['400 16px "KaTeX_Main"', 'E=mc2'],
	['italic 400 16px "KaTeX_Main"', 'x'],
	['700 16px "KaTeX_Main"', 'B'],
	['italic 700 16px "KaTeX_Main"', 'B'],
	['italic 400 16px "KaTeX_Math"', 'λσ'],
	['italic 700 16px "KaTeX_Math"', 'λσ'],
	['400 16px "KaTeX_SansSerif"', 'S'],
	['italic 400 16px "KaTeX_SansSerif"', 'S'],
	['700 16px "KaTeX_SansSerif"', 'S'],
	['400 16px "KaTeX_Script"', 'S'],
	['400 16px "KaTeX_Size1"', '()'],
	['400 16px "KaTeX_Size2"', '()'],
	['400 16px "KaTeX_Size3"', '()'],
	['400 16px "KaTeX_Size4"', '()'],
	['400 16px "KaTeX_Typewriter"', 'T'],
];

function typographyFixture() {
	return [
		'# Heading near $E = mc^2$',
		'',
		'Inline baseline: $E = mc^2$, $\\lambda_\\pm$, $\\sigma_{xy}$, $R_s^{-1}\\chi R_s$, and $\\det(R_s)$.',
		'',
		'- List item with $\\sqrt{x^2+y^2}$ and $\\frac{a+b}{c+d}$.',
		'> Blockquote with $\\sum_{n=1}^{\\infty} n^{-2}$ and $\\int_0^1 f(x)\\,dx$.',
		'',
		'`code keeps $not_math$ as source`',
		'',
		'$$',
		'\\left\\{ \\begin{aligned} a &= b + c \\\\ d &= e - f \\end{aligned} \\right.',
		'$$',
		'',
		'$$',
		'\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} \\quad \\mathbb{R} \\; \\mathcal{C} \\; \\mathfrak{g} \\; \\mathsf{S} \\; \\mathtt{T} \\; \\mathscr{L}',
		'$$',
		'',
		'After display math, another inline formula $x_i^2$.',
	].join('\n');
}

function equationFixture(count, oneLine = false) {
	const formulas = Array.from({ length: count }, (_, index) => `$x_{${index}} + \\lambda_{${index % 7}}$`);
	return oneLine ? `LOCAL-START ${formulas.join(' ')} LOCAL-END` : formulas.map((formula, index) => `Equation ${index}: ${formula}`).join('\n');
}

function editPreviewFixture() {
	return ['Inline edit $x^2$ remains source while its preview follows input.', '', '$$', 'y = mx + b', '$$', '', 'After the formula.'].join('\n');
}

async function settle(page, delay = 30) {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	if (delay) await page.waitForTimeout(delay);
}

async function init(page, text, zoomPercent = 100, css = '') {
	await page.evaluate(({ text, zoomPercent, css }) => {
		window.__mlpTestSourceText = text;
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'init', text, version: Date.now(), css, codeTheme: 'light-plus',
			baseUri: location.origin + '/', dialect: 'quarto', zoomPercent,
		} }));
	}, { text, zoomPercent, css });
	await page.waitForFunction((length) => window.__mlpDebugSnapshot?.()?.docLength === length, text.length, { timeout: 10000 });
	await page.evaluate(() => document.fonts.ready);
	await settle(page);
}

async function main() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const pageErrors = [];
	const fontFailures = [];
	page.on('pageerror', (error) => pageErrors.push(String(error)));
	page.on('response', (response) => {
		if (/\/media\/fonts\//.test(response.url()) && !response.ok()) fontFailures.push({ url: response.url(), status: response.status() });
	});

	try {
		await page.goto(`${baseUrl}/scripts/long-document-browser-harness.html?probe=1`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.__mlpLongDocumentResult !== undefined, null, { timeout: 30000 });

		const source = typographyFixture();
		await init(page, source);
		const faceLoads = await page.evaluate(async (faces) => Promise.all(faces.map(async ([descriptor, sample]) => ({
			descriptor,
			loaded: (await document.fonts.load(descriptor, sample)).length,
		}))), requiredFaces);
		await settle(page);
		assert(faceLoads.every((face) => face.loaded > 0), 'one or more bundled KaTeX faces did not load', { faceLoads });
		assert(fontFailures.length === 0, 'KaTeX font requests failed', { fontFailures });

		const typography = await page.evaluate(() => {
			const style = (selector) => {
				const element = document.querySelector(selector);
				if (!(element instanceof HTMLElement)) return null;
				const computed = getComputedStyle(element);
				return { family: computed.fontFamily, color: computed.color, fontSize: computed.fontSize, fontWeight: computed.fontWeight, transform: computed.transform, opacity: computed.opacity };
			};
			return {
				fontState: document.querySelector('#mlp-root')?.getAttribute('data-mlp-katex-fonts'),
				widgetCount: document.querySelectorAll('.mlp-math').length,
				root: style('.katex'), math: style('.mathnormal'), ams: style('.mathbb'),
				caligraphic: style('.mathcal'), fraktur: style('.mathfrak'), sans: style('.mathsf'), typewriter: style('.mathtt'),
			};
		});
		assert(typography.fontState === 'ready', 'font completion was not observed', { typography });
		assert(typography.widgetCount >= 13, 'complex formula fixture was not rendered', { typography });
		for (const [name, family] of [['root', 'KaTeX_Main'], ['math', 'KaTeX_Math'], ['ams', 'KaTeX_AMS'], ['caligraphic', 'KaTeX_Caligraphic'], ['fraktur', 'KaTeX_Fraktur'], ['sans', 'KaTeX_SansSerif'], ['typewriter', 'KaTeX_Typewriter']]) {
			assert(typography[name]?.family.startsWith(family), `wrong computed family for ${name}`, { typography });
		}
		assert(typography.root.fontWeight === '400' && typography.root.transform === 'none' && typography.root.opacity === '1', 'KaTeX root uses synthetic visual weight/scale', { typography });
		const mathBaseline = await page.evaluate(() => {
			const paragraph = document.querySelector('.cm-line.mlp-line-paragraph');
			const inline = paragraph?.querySelector('.mlp-math-inline .katex');
			const display = document.querySelector('.mlp-math-display .katex');
			const content = document.querySelector('.cm-content');
			const fontSize = (element) => element ? parseFloat(getComputedStyle(element).fontSize) : 0;
			return {
				paragraph: fontSize(paragraph),
				content: fontSize(content),
				inline: fontSize(inline),
				display: fontSize(display),
			};
		});
		assert(mathBaseline.paragraph > 0 && mathBaseline.content > 0, 'typography fixture did not render a measurable prose baseline', { mathBaseline });
		assert(Math.abs(mathBaseline.inline / mathBaseline.paragraph - 1) < 0.03, 'inline math body is not visually aligned with surrounding prose', { mathBaseline });
		assert(Math.abs(mathBaseline.display / mathBaseline.content - 1) < 0.03, 'display math base is not visually aligned with document typography', { mathBaseline });

		const colors = {};
		colors.light = typography.root.color;
		await page.evaluate(() => {
			document.documentElement.style.setProperty('--vscode-editor-foreground', '#e6e6e6');
			document.documentElement.style.setProperty('--vscode-editor-background', '#171717');
			document.body.classList.add('vscode-dark');
		});
		await settle(page);
		colors.dark = await page.locator('.katex').first().evaluate((element) => getComputedStyle(element).color);
		assert(colors.light === 'rgb(32, 33, 36)' && colors.dark === 'rgb(230, 230, 230)', 'math did not inherit light/dark foreground', { colors });
		await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'applyCss', css: '.mlp-math { color: rgb(12, 34, 56); } .mlp-math-display { padding: 0.9em 0; }' } })));
		await settle(page);
		colors.custom = await page.locator('.katex').first().evaluate((element) => getComputedStyle(element).color);
		assert(colors.custom === 'rgb(12, 34, 56)', 'custom CSS could not override math color', { colors });

		const zoom = [];
		for (const percent of [70, 100, 150, 200]) {
			await page.evaluate((value) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setZoom', percent: value } })), percent);
			await settle(page);
			zoom.push(await page.evaluate((value) => {
				const formula = document.querySelector('.mlp-math-inline .katex');
				const content = document.querySelector('.cm-content');
				const rect = formula?.getBoundingClientRect();
				return { percent: value, width: rect?.width ?? 0, height: rect?.height ?? 0, contentFontSize: content ? parseFloat(getComputedStyle(content).fontSize) : 0 };
			}, percent));
		}
		const baseline = zoom.find((item) => item.percent === 100);
		for (const item of zoom) {
			const expected = item.percent / 100;
			assert(Math.abs(item.width / baseline.width - expected) < 0.08, 'formula width did not follow document zoom', { zoom });
			assert(Math.abs(item.contentFontSize / baseline.contentFontSize - expected) < 0.02, 'body font did not follow document zoom', { zoom });
		}

		await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setZoom', percent: 100 } })));
		await settle(page);
		const displayFrom = source.indexOf('$$');
		const geometry = await page.evaluate((pos) => {
			const widget = document.querySelector('.mlp-math-display');
			const rect = widget?.getBoundingClientRect();
			const block = window.__mlpDebugLineBlock?.(pos);
			const scroller = document.querySelector('.cm-scroller');
			return { rect: rect ? { top: rect.top, height: rect.height } : null, block, scrollHeight: scroller?.scrollHeight ?? 0 };
		}, displayFrom);
		assert(geometry.rect && geometry.block && Math.abs(geometry.rect.height - geometry.block.height) <= 1.5, 'display formula height map differs from DOM geometry', { geometry });

		const clickTex = 'R_s^{-1}\\chi R_s';
		const clickFrom = source.indexOf(`$${clickTex}$`);
		await page.getByRole('math', { name: clickTex }).click({ position: { x: 4, y: 4 } });
		await settle(page);
		const clicked = await page.evaluate(() => window.__mlpDebugSelection?.());
		assert(clicked?.head === clickFrom + 1, 'inline formula mouse hit mapped to the wrong source range', { clicked, clickFrom });
		assert(clicked?.x !== null && clicked?.y !== null && clicked.blockHeight > 0 && Math.abs(clicked.blockHeight - clicked.defaultLineHeight) <= 1.5, 'formula hit left caret or line-height geometry inconsistent', { clicked });

		const localitySource = equationFixture(100, true);
		await init(page, localitySource);
		await page.waitForFunction(() => document.querySelectorAll('.mlp-math-inline').length === 100);
		await page.evaluate(() => [...document.querySelectorAll('.mlp-math-inline')].forEach((node, index) => { node.dataset.localityId = String(index); }));
		const targetToken = '$x_{50} + \\lambda_{1}$';
		const targetFrom = localitySource.indexOf(targetToken);
		const insertAt = targetFrom + targetToken.length - 1;
		await page.evaluate(({ targetFrom, insertAt }) => {
			window.__mlpDebugSetSelection?.(targetFrom + 2);
			window.__mlpDebugEdit?.(insertAt, insertAt, '+1');
			window.__mlpDebugSetSelection?.(0);
		}, { targetFrom, insertAt });
		await page.waitForFunction(() => document.querySelectorAll('.mlp-math-inline').length === 100);
		await settle(page);
		const locality = await page.evaluate(() => {
			const nodes = [...document.querySelectorAll('.mlp-math-inline')];
			return { total: nodes.length, reused: nodes.filter((node) => node.dataset.localityId !== undefined).length, newNodes: nodes.filter((node) => node.dataset.localityId === undefined).length };
		});
		assert(locality.reused === 99 && locality.newNodes === 1, 'editing one formula rerendered unaffected widgets', { locality });
		const shiftedToken = '$x_{80} + \\lambda_{3}$';
		const shiftedSource = localitySource.slice(0, insertAt) + '+1' + localitySource.slice(insertAt);
		const shiftedFrom = shiftedSource.indexOf(shiftedToken);
		await page.getByRole('math', { name: 'x_{80} + \\lambda_{3}' }).click({ position: { x: 4, y: 4 } });
		await settle(page);
		const shiftedClick = await page.evaluate(() => window.__mlpDebugSelection?.());
		assert(shiftedClick?.head === shiftedFrom + 1, 'reused shifted widget retained a stale source offset', { shiftedClick, shiftedFrom });

		const performanceRuns = [];
		for (const count of [20, 100, 500]) {
			const fixture = equationFixture(count);
			const started = performance.now();
			await init(page, fixture);
			const readyMs = Number((performance.now() - started).toFixed(1));
			const scrollStarted = performance.now();
			await page.evaluate(() => window.__mlpDebugScrollTo?.(Number.MAX_SAFE_INTEGER));
			await settle(page, 80);
			const scrollMs = Number((performance.now() - scrollStarted).toFixed(1));
			const state = await page.evaluate(() => ({ snapshot: window.__mlpDebugSnapshot?.(), visibleMath: document.querySelectorAll('.mlp-math').length }));
			performanceRuns.push({ count, readyMs, scrollMs, visibleMath: state.visibleMath, scrollTop: state.snapshot?.scrollTop, scrollHeight: state.snapshot?.scrollHeight, clientHeight: state.snapshot?.clientHeight });
		}
		assert(performanceRuns.every((run) => run.readyMs < 5000 && run.scrollMs < 2500 && run.visibleMath > 0 && run.scrollTop + run.clientHeight >= run.scrollHeight - 3), 'equation-heavy render or scroll regression', { performanceRuns });

		// Issue #41: editing keeps the source in CodeMirror while a single, absolute
		// KaTeX preview follows the collapsed caret. The preview must update for both
		// valid and malformed intermediate TeX without entering document flow.
		const editSource = editPreviewFixture();
		await init(page, editSource);
		const originalInlineFrom = editSource.indexOf('$x^2$');
		const originalDisplayFrom = editSource.indexOf('$$');
		const initialInlinePosition = originalInlineFrom + 2;
		await page.evaluate((pos) => window.__mlpDebugSetSelection?.(pos), initialInlinePosition);
		await page.waitForFunction(() => {
			const preview = document.querySelector('.mlp-math-edit-preview');
			return preview instanceof HTMLElement && !preview.hidden && Boolean(preview.querySelector('.mlp-math-inline'));
		});
		const inlinePreview = await page.evaluate(() => {
			const preview = document.querySelector('.mlp-math-edit-preview');
			const math = preview?.querySelector('.mlp-math-inline');
			const editor = document.querySelector('.cm-editor')?.getBoundingClientRect();
			const rect = preview?.getBoundingClientRect();
			const selection = window.__mlpDebugSelection?.();
			const sourceVisible = document.querySelector('.cm-content')?.textContent?.includes('$x^2$') ?? false;
			return {
				visible: preview instanceof HTMLElement && !preview.hidden,
				label: math?.getAttribute('aria-label'),
				previewCount: document.querySelectorAll('.mlp-math-edit-preview').length,
				sourceVisible,
				selection,
				geometry: rect && editor ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, editorLeft: editor.left, editorTop: editor.top, editorRight: editor.right, editorBottom: editor.bottom, width: rect.width, height: rect.height } : null,
			};
		});
		assert(inlinePreview.visible && inlinePreview.previewCount === 1 && inlinePreview.label === 'x^2', 'inline edit preview did not render beside raw source', { inlinePreview });
		assert(inlinePreview.sourceVisible, 'edit preview replaced or hid the canonical source text', { inlinePreview });
		assert(inlinePreview.geometry && inlinePreview.geometry.width > 0 && inlinePreview.geometry.height > 0 && inlinePreview.geometry.left >= inlinePreview.geometry.editorLeft - 0.5 && inlinePreview.geometry.right <= inlinePreview.geometry.editorRight + 0.5 && inlinePreview.geometry.top >= inlinePreview.geometry.editorTop - 0.5 && inlinePreview.geometry.bottom <= inlinePreview.geometry.editorBottom + 0.5, 'inline preview escaped the editor geometry', { inlinePreview });

		const invalidInline = '\\frac{a';
		await page.evaluate(({ from, insert }) => {
			window.__mlpDebugEdit?.(from + 1, from + 4, insert);
			window.__mlpDebugSetSelection?.(from + 1 + insert.length);
		}, { from: originalInlineFrom, insert: invalidInline });
		await page.waitForFunction((label) => document.querySelector('.mlp-math-edit-preview .mlp-math')?.getAttribute('aria-label') === label, invalidInline);
		const invalidState = await page.evaluate(() => ({ previewVisible: !(document.querySelector('.mlp-math-edit-preview') instanceof HTMLElement) ? false : !document.querySelector('.mlp-math-edit-preview').hidden, selection: window.__mlpDebugSelection?.() }));
		assert(invalidState.previewVisible, 'invalid intermediate TeX hid the edit preview', { invalidState });
		assert(invalidState.selection?.head === originalInlineFrom + 1 + invalidInline.length, 'preview update changed the editor selection', { invalidState, expected: originalInlineFrom + 1 + invalidInline.length });

		const deletedInline = invalidInline.slice(0, -1);
		await page.evaluate(({ from, length }) => {
			window.__mlpDebugEdit?.(from + 1 + length - 1, from + 1 + length, '');
			window.__mlpDebugSetSelection?.(from + 1 + length - 1);
		}, { from: originalInlineFrom, length: invalidInline.length });
		await page.waitForFunction((label) => document.querySelector('.mlp-math-edit-preview .mlp-math')?.getAttribute('aria-label') === label, deletedInline);
		const deletedState = await page.evaluate(() => ({ previewVisible: !(document.querySelector('.mlp-math-edit-preview') instanceof HTMLElement) ? false : !document.querySelector('.mlp-math-edit-preview').hidden, selection: window.__mlpDebugSelection?.() }));
		assert(deletedState.previewVisible && deletedState.selection?.head === originalInlineFrom + 1 + deletedInline.length, 'deleting TeX disrupted the edit preview or selection', { deletedState, expected: originalInlineFrom + 1 + deletedInline.length });

		const validInline = '\\frac{a}{b}';
		await page.evaluate(({ from, oldBody, insert }) => {
			window.__mlpDebugEdit?.(from + 1, from + 1 + oldBody.length, insert);
			window.__mlpDebugSetSelection?.(from + 1 + insert.length - 1);
		}, { from: originalInlineFrom, oldBody: deletedInline, insert: validInline });
		await page.waitForFunction((label) => document.querySelector('.mlp-math-edit-preview .mlp-math')?.getAttribute('aria-label') === label, validInline);
		const inlineDelta = validInline.length - 'x^2'.length;
		const editedDisplayFrom = originalDisplayFrom + inlineDelta;
		await page.evaluate((pos) => window.__mlpDebugSetSelection?.(pos), editedDisplayFrom + 3);
		await page.waitForFunction(() => {
			const preview = document.querySelector('.mlp-math-edit-preview');
			return preview instanceof HTMLElement && !preview.hidden && preview.dataset.display === 'true' && Boolean(preview.querySelector('.mlp-math-display'));
		});
		const displaySource = '$$\ny = mx + b\n$$';
		const displayTo = editedDisplayFrom + displaySource.length;
		const displayPreview = await page.evaluate(({ from, to }) => {
			const preview = document.querySelector('.mlp-math-edit-preview');
			const math = preview?.querySelector('.mlp-math-display');
			const rect = preview?.getBoundingClientRect();
			const start = window.__mlpDebugCoordsAtPos?.(from, 1);
			const end = window.__mlpDebugCoordsAtPos?.(to, -1);
			return { label: math?.getAttribute('aria-label'), display: preview?.dataset.display, height: rect?.height ?? 0, top: rect?.top ?? 0, bottom: rect?.bottom ?? 0, sourceTop: start?.top ?? 0, sourceBottom: end?.bottom ?? 0 };
		}, { from: editedDisplayFrom, to: displayTo });
		assert(displayPreview.display === 'true' && displayPreview.label === 'y = mx + b' && displayPreview.height > 0, 'display-math edit preview did not render', { displayPreview });
		assert(displayPreview.top >= displayPreview.sourceBottom - 1 || displayPreview.bottom <= displayPreview.sourceTop + 1, 'display edit preview covered its raw source lines', { displayPreview });

		const invalidDisplay = '\\sqrt{';
		const displayBodyFrom = editedDisplayFrom + 3;
		const displayBody = 'y = mx + b';
		await page.evaluate(({ from, oldBody, insert }) => {
			window.__mlpDebugEdit?.(from, from + oldBody.length, insert);
			window.__mlpDebugSetSelection?.(from + insert.length);
		}, { from: displayBodyFrom, oldBody: displayBody, insert: invalidDisplay });
		await page.waitForFunction((label) => document.querySelector('.mlp-math-edit-preview .mlp-math')?.getAttribute('aria-label') === label, invalidDisplay);

		await page.evaluate(() => window.__mlpDebugSetSelection?.(0));
		await page.waitForFunction(() => {
			const preview = document.querySelector('.mlp-math-edit-preview');
			return preview instanceof HTMLElement && preview.hidden && Boolean(document.querySelector('.cm-content .mlp-math-inline')) && Boolean(document.querySelector('.cm-content .mlp-math-display'));
		});
		const exited = await page.evaluate(() => ({
			previewHidden: (document.querySelector('.mlp-math-edit-preview'))?.hidden ?? false,
			inlineRendered: Boolean(document.querySelector('.cm-content .mlp-math-inline')),
			displayRendered: Boolean(document.querySelector('.cm-content .mlp-math-display')),
		}));
		assert(exited.previewHidden && exited.inlineRendered && exited.displayRendered, 'leaving a formula did not restore normal KaTeX rendering', { exited });

		const previewGeometry = [];
		for (const percent of [70, 100, 200]) {
			await page.evaluate((value) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setZoom', percent: value } })), percent);
			await page.evaluate((pos) => window.__mlpDebugSetSelection?.(pos), originalInlineFrom + 1);
			await page.waitForFunction(() => {
				const preview = document.querySelector('.mlp-math-edit-preview');
				return preview instanceof HTMLElement && !preview.hidden;
			});
			previewGeometry.push(await page.evaluate((value) => {
				const preview = document.querySelector('.mlp-math-edit-preview')?.getBoundingClientRect();
				const editor = document.querySelector('.cm-editor')?.getBoundingClientRect();
				return { percent: value, preview: preview && { left: preview.left, top: preview.top, right: preview.right, bottom: preview.bottom, width: preview.width, height: preview.height }, editor: editor && { left: editor.left, top: editor.top, right: editor.right, bottom: editor.bottom } };
			}, percent));
		}
		assert(previewGeometry.every(({ preview, editor }) => preview && editor && preview.width > 0 && preview.height > 0 && preview.left >= editor.left - 0.5 && preview.right <= editor.right + 0.5 && preview.top >= editor.top - 0.5 && preview.bottom <= editor.bottom + 0.5), 'edit preview geometry became unstable across document zoom levels', { previewGeometry });

		const longEditSource = equationFixture(500);
		const tailFormula = '$x_{499} + \\lambda_{2}$';
		const tailFrom = longEditSource.lastIndexOf(tailFormula);
		await init(page, longEditSource);
		await page.evaluate((pos) => {
			window.__mlpDebugScrollToPosition?.(pos);
			window.__mlpDebugSetSelection?.(pos + 4);
		}, tailFrom);
		await page.waitForFunction(() => {
			const preview = document.querySelector('.mlp-math-edit-preview');
			return preview instanceof HTMLElement && !preview.hidden;
		});
		const longEdit = await page.evaluate(() => {
			const preview = document.querySelector('.mlp-math-edit-preview')?.getBoundingClientRect();
			const editor = document.querySelector('.cm-editor')?.getBoundingClientRect();
			const snapshot = window.__mlpDebugSnapshot?.();
			return {
				preview: preview && { left: preview.left, top: preview.top, right: preview.right, bottom: preview.bottom },
				editor: editor && { left: editor.left, top: editor.top, right: editor.right, bottom: editor.bottom },
				domLineCount: snapshot?.domLineCount,
				docLines: snapshot?.docLines,
				scrollAtEnd: snapshot ? snapshot.scrollTop + snapshot.clientHeight >= snapshot.scrollHeight - 3 : false,
			};
		});
		assert(longEdit.preview && longEdit.editor && longEdit.preview.left >= longEdit.editor.left - 0.5 && longEdit.preview.right <= longEdit.editor.right + 0.5 && longEdit.preview.top >= longEdit.editor.top - 0.5 && longEdit.preview.bottom <= longEdit.editor.bottom + 0.5 && longEdit.scrollAtEnd && (longEdit.domLineCount ?? Number.MAX_SAFE_INTEGER) < (longEdit.docLines ?? 0), 'long-document edit preview was not viewport-stable', { longEdit });
		assert(pageErrors.length === 0, 'browser page errors occurred', { pageErrors });

		const fontRequests = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/media/fonts/')).length);
		console.log(JSON.stringify({ ok: true, faceLoads, typography, colors, zoom, geometry, locality, shiftedClick, performanceRuns, inlinePreview, invalidState, deletedState, displayPreview, exited, previewGeometry, longEdit, fontRequests }, null, 2));
	} finally {
		await page.close();
		await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
}

main().catch((error) => {
	console.error(error?.stack || error);
	process.exitCode = 1;
});
