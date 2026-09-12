#!/usr/bin/env node

/*
 * Focused browser regression for Issue 28. The page uses the same real
 * CodeMirror bundle and fixture harness as the existing long-document tests;
 * the assertions cover independent typography and reading-width controls.
 */

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
		'.json': 'application/json',
		'.svg': 'image/svg+xml',
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
				response.writeHead(403);
				response.end('forbidden');
				return;
			}
			const contents = await fs.readFile(candidate);
			response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mimeType(candidate) });
			response.end(contents);
		} catch (error) {
			const status = error?.code === 'ENOENT' ? 404 : 500;
			response.writeHead(status);
			response.end(status === 404 ? 'not found' : String(error));
		}
	});
}

function assert(condition, message, details = {}) {
	if (!condition) throw new Error(JSON.stringify({ message, ...details }));
}

async function settle(page) {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	await page.waitForTimeout(30);
}

async function dispatchKey(page, key, code, modifiers = {}) {
	return page.evaluate(({ key, code, modifiers }) => {
		const target = document.querySelector('.cm-content');
		if (!(target instanceof HTMLElement)) throw new Error('editor content is not mounted');
		const event = new KeyboardEvent('keydown', {
			key,
			code,
			bubbles: true,
			cancelable: true,
			ctrlKey: modifiers.ctrlKey === true,
			metaKey: modifiers.metaKey === true,
			altKey: modifiers.altKey === true,
			shiftKey: modifiers.shiftKey === true,
		});
		const dispatched = target.dispatchEvent(event);
		return { dispatched, defaultPrevented: event.defaultPrevented };
	}, { key, code, modifiers });
}

async function dispatchWheel(page, deltaY, modifiers = {}) {
	return page.evaluate(({ deltaY, modifiers }) => {
		const target = document.querySelector('.cm-scroller');
		if (!(target instanceof HTMLElement)) throw new Error('editor scroller is not mounted');
		const event = new WheelEvent('wheel', {
			deltaY,
			bubbles: true,
			cancelable: true,
			ctrlKey: modifiers.ctrlKey === true,
			metaKey: modifiers.metaKey === true,
		});
		const dispatched = target.dispatchEvent(event);
		return { dispatched, defaultPrevented: event.defaultPrevented };
	}, { deltaY, modifiers });
}

async function snapshot(page) {
	return page.evaluate(() => {
		const root = document.querySelector('#mlp-root');
		const content = document.querySelector('.cm-content');
		const scroller = document.querySelector('.cm-scroller');
		const state = window.__mlpDebugSnapshot?.();
		return {
			zoom: root?.style.getPropertyValue('--mlp-document-zoom') || '',
			readingWidth: root?.style.getPropertyValue('--mlp-reading-width') || '',
			readingWidthState: root?.dataset.mlpReadingWidth || '',
			readingColumnMaxWidth: root?.style.getPropertyValue('--mlp-reading-column-max-width') || '',
			fontSize: content ? getComputedStyle(content).fontSize : '',
			maxWidth: content ? getComputedStyle(content).maxWidth : '',
			transform: content ? getComputedStyle(content).transform : '',
			contentWidth: content?.getBoundingClientRect().width ?? null,
			contentLeft: content?.getBoundingClientRect().left ?? null,
			contentRight: content?.getBoundingClientRect().right ?? null,
			viewportWidth: scroller?.clientWidth ?? null,
			scrollTop: scroller?.scrollTop ?? null,
			scrollHeight: scroller?.scrollHeight ?? null,
			contentHeight: state?.contentHeight ?? null,
			docLength: state?.docLength ?? null,
			selection: window.__mlpDebugSelection?.() ?? null,
		};
	});
}

async function main() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const builtInThemes = await Promise.all([
		['github-light', fs.readFile(path.join(REPO, 'media/sample-styles/github-light.css'), 'utf8')],
		['github-dark', fs.readFile(path.join(REPO, 'media/sample-styles/github-dark.css'), 'utf8')],
		['claude', fs.readFile(path.join(REPO, 'media/sample-styles/claude.css'), 'utf8')],
	]);
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(String(error)));

	try {
		await page.goto(`${baseUrl}/scripts/long-document-browser-harness.html`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.__mlpLongDocumentResult !== undefined, null, { timeout: 30000 });
		const baselineResult = await page.evaluate(() => window.__mlpLongDocumentResult);
		assert(baselineResult.ok, 'existing long-document baseline failed', { baselineResult });

		const initial = await snapshot(page);
		assert(initial.zoom === '1' && initial.readingWidth === '1' && initial.readingWidthState === '100' && initial.readingColumnMaxWidth === '', 'zoom did not start at 100%', { initial });
		assert(initial.docLength > 1000, 'zoom fixture is not a long document', { initial });

		await page.locator('.cm-content').focus();
		const focusedBefore = await snapshot(page);
		const plus = await dispatchKey(page, '=', 'Equal', { ctrlKey: true, shiftKey: true });
		await settle(page);
		const focusedAfter = await snapshot(page);
		assert(plus.defaultPrevented, 'Ctrl+Plus was not consumed by Live Preview', { plus });
		assert(focusedAfter.zoom === focusedBefore.zoom && focusedAfter.readingWidth === '1.1' && focusedAfter.fontSize === focusedBefore.fontSize, 'Ctrl+Plus did not increase reading width only', { focusedBefore, focusedAfter });
		assert(focusedAfter.docLength === focusedBefore.docLength, 'zoom modified document text', { focusedBefore, focusedAfter });
		assert(focusedAfter.selection?.head === focusedBefore.selection?.head, 'Ctrl+Plus moved the caret', { focusedBefore, focusedAfter });

		const plainWheel = await dispatchWheel(page, -120);
		await settle(page);
		const afterPlainWheel = await snapshot(page);
		assert(!plainWheel.defaultPrevented, 'plain wheel was intercepted', { plainWheel });
		assert(afterPlainWheel.zoom === focusedAfter.zoom && afterPlainWheel.readingWidth === focusedAfter.readingWidth, 'plain wheel changed a document preference', { afterPlainWheel });

		const ctrlWheel = await dispatchWheel(page, -120, { ctrlKey: true });
		await settle(page);
		const afterCtrlWheel = await snapshot(page);
		assert(ctrlWheel.defaultPrevented && afterCtrlWheel.zoom === '1.1' && afterCtrlWheel.readingWidth === '1.1', 'Ctrl+wheel did not increase typography only', { ctrlWheel, afterCtrlWheel });
		assert(afterCtrlWheel.selection?.head === focusedAfter.selection?.head, 'Ctrl+wheel moved the caret', { focusedAfter, afterCtrlWheel });

		for (let i = 0; i < 6; i++) await dispatchKey(page, '+', 'Equal', { ctrlKey: true, shiftKey: true });
		await settle(page);
		const width170 = await snapshot(page);
		assert(width170.readingWidth === '1.7' && width170.readingWidthState === '170' && width170.zoom === '1.1', 'reading width did not reach the 170% step without changing typography', { width170 });
		const width180Key = await dispatchKey(page, '+', 'Equal', { ctrlKey: true, shiftKey: true });
		await settle(page);
		const width180 = await snapshot(page);
		assert(width180Key.defaultPrevented && width180.readingWidth === '1.8' && width180.readingWidthState === '180' && width180.zoom === '1.1', 'reading width did not reach its 180% step', { width180Key, width180 });
		const fullKey = await dispatchKey(page, '+', 'Equal', { ctrlKey: true, shiftKey: true });
		await settle(page);
		const full = await snapshot(page);
		assert(fullKey.defaultPrevented && full.readingWidth === '1.8' && full.readingWidthState === 'full' && full.readingColumnMaxWidth === 'none' && full.transform === 'none', '180% plus did not enter the responsive Full reading-width state', { fullKey, full });
		const fullPlus = await dispatchKey(page, '+', 'Equal', { ctrlKey: true, shiftKey: true });
		await settle(page);
		const fullAgain = await snapshot(page);
		assert(fullPlus.defaultPrevented && fullAgain.readingWidthState === 'full' && fullAgain.readingWidth === full.readingWidth, 'Full reading width was not stable at the upper boundary', { fullPlus, fullAgain });
		const fullTypographyKey = await dispatchWheel(page, -120, { ctrlKey: true });
		await settle(page);
		const fullTypography = await snapshot(page);
		assert(fullTypographyKey.defaultPrevented && fullTypography.zoom === '1.2' && fullTypography.readingWidthState === 'full', 'typography zoom while Full changed reading width state', { fullTypographyKey, fullTypography });
		const fullMinus = await dispatchKey(page, '-', 'Minus', { ctrlKey: true });
		await settle(page);
		const widthMaximum = await snapshot(page);
		assert(fullMinus.defaultPrevented && widthMaximum.readingWidth === '1.8' && widthMaximum.readingWidthState === '180' && widthMaximum.readingColumnMaxWidth === '' && widthMaximum.zoom === '1.2', 'Ctrl+Minus did not leave Full at the 180% step', { fullMinus, widthMaximum });

		await page.setViewportSize({ width: 1600, height: 800 });
		await settle(page);
		await page.evaluate(() => {
			const source = window.__mlpTestSourceText || '';
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'init', text: source, version: 2, css: '', codeTheme: 'light-plus', baseUri: location.origin + '/', dialect: 'quarto', typewriterMode: false, zoomPercent: 120, readingWidthPercent: 'full',
			} }));
		});
		await settle(page);
		const fullWideState = await snapshot(page);
		await page.setViewportSize({ width: 900, height: 800 });
		await settle(page);
		const fullNarrowState = await snapshot(page);
		assert(fullWideState.readingWidthState === 'full' && fullNarrowState.readingWidthState === 'full' && fullWideState.contentWidth > fullNarrowState.contentWidth + 100, 'Full reading width did not respond to viewport resize', { fullWideState, fullNarrowState });
		await page.setViewportSize({ width: 1280, height: 800 });
		await settle(page);

		for (let i = 0; i < 20; i++) await dispatchWheel(page, -120, { ctrlKey: true });
		await settle(page);
		const fontMaximum = await snapshot(page);
		assert(fontMaximum.zoom === '2' && fontMaximum.readingWidth === '1.8' && fontMaximum.readingWidthState === 'full', 'typography exceeded its 200% boundary or changed Full reading width', { fontMaximum });
		const atFontMaximum = await dispatchWheel(page, -120, { ctrlKey: true });
		assert(atFontMaximum.defaultPrevented, 'boundary Ctrl+wheel was allowed to reach browser zoom', { atFontMaximum });
		for (let i = 0; i < 20; i++) await dispatchWheel(page, 120, { ctrlKey: true });
		await settle(page);
		const fontMinimum = await snapshot(page);
		assert(fontMinimum.zoom === '0.7' && fontMinimum.readingWidth === '1.8' && fontMinimum.readingWidthState === 'full', 'typography fell below its 70% boundary or changed Full reading width', { fontMinimum });
		for (let i = 0; i < 20; i++) await dispatchWheel(page, -120, { ctrlKey: true });
		await settle(page);

		for (let i = 0; i < 20; i++) await dispatchKey(page, '-', 'Minus', { ctrlKey: true });
		await settle(page);
		const widthMinimum = await snapshot(page);
		assert(widthMinimum.readingWidth === '0.6' && widthMinimum.readingWidthState === '60' && widthMinimum.zoom === '2', 'reading width fell below its 60% boundary or changed typography', { widthMinimum });
		const atWidthMinimum = await dispatchKey(page, '-', 'Minus', { ctrlKey: true });
		assert(atWidthMinimum.defaultPrevented, 'boundary Ctrl+Minus was allowed to reach browser zoom', { atWidthMinimum });

		const reset = await dispatchKey(page, '0', 'Digit0', { ctrlKey: true });
		await settle(page);
		const resetState = await snapshot(page);
		assert(reset.defaultPrevented && resetState.zoom === '1' && resetState.readingWidth === '0.6' && resetState.readingWidthState === '60', 'Ctrl+0 did not reset typography only', { reset, resetState });

		for (let i = 0; i < 12; i++) await dispatchKey(page, '+', 'Equal', { ctrlKey: true, shiftKey: true });
		await dispatchKey(page, '+', 'Equal', { ctrlKey: true, shiftKey: true });
		await settle(page);
		const fullBeforeReset = await snapshot(page);
		assert(fullBeforeReset.readingWidthState === 'full' && fullBeforeReset.zoom === '1', 'reading width did not re-enter Full before the independent reset', { fullBeforeReset });

		const widthReset = await dispatchKey(page, ')', 'Digit0', { ctrlKey: true, shiftKey: true });
		await settle(page);
		const widthResetState = await snapshot(page);
		assert(widthReset.defaultPrevented && widthResetState.zoom === '1' && widthResetState.readingWidth === '1' && widthResetState.readingWidthState === '100', 'Ctrl+Shift+0 did not reset reading width only', { widthReset, widthResetState });
		assert(widthResetState.transform === 'none', 'reading width used whole-editor transform scaling', { widthResetState });

		await page.evaluate(() => {
			const outside = document.createElement('button');
			outside.id = 'outside-focus-target';
			outside.textContent = 'outside';
			document.body.appendChild(outside);
			outside.focus();
		});
		const unfocusedKey = await dispatchKey(page, '+', 'Equal', { ctrlKey: true, shiftKey: true });
		const unfocusedWheel = await dispatchWheel(page, -120, { ctrlKey: true });
		const unfocused = await snapshot(page);
		assert(!unfocusedKey.defaultPrevented && !unfocusedWheel.defaultPrevented && unfocused.zoom === '1' && unfocused.readingWidth === '1' && unfocused.readingWidthState === '100', 'unfocused editor intercepted document zoom input', { unfocusedKey, unfocusedWheel, unfocused });

		await page.evaluate(() => {
			const source = window.__mlpTestSourceText || '';
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'init', text: source, version: 2, css: '', codeTheme: 'light-plus', baseUri: location.origin + '/', dialect: 'quarto', typewriterMode: false, zoomPercent: 140, readingWidthPercent: 160,
			} }));
		});
		await page.waitForTimeout(160);
		const reinitialized = await snapshot(page);
		assert(reinitialized.zoom === '1.4' && reinitialized.readingWidth === '1.6' && reinitialized.docLength === resetState.docLength, 'reopening a document did not apply both shared preference values', { reinitialized });

		await page.evaluate(() => {
			const source = window.__mlpTestSourceText || '';
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'init', text: source, version: 3, css: '', codeTheme: 'light-plus', baseUri: location.origin + '/', dialect: 'quarto', typewriterMode: false, zoomPercent: 140, readingWidthPercent: 'full',
			} }));
		});
		await settle(page);
		const fullReinitialized = await snapshot(page);
		assert(fullReinitialized.zoom === '1.4' && fullReinitialized.readingWidth === '1.8' && fullReinitialized.readingWidthState === 'full', 'reopening a document did not restore Full reading width', { fullReinitialized });

		const fixedThemeCss = 'body { max-width: 980px; }';
		await page.evaluate((css) => {
			const source = window.__mlpTestSourceText || '';
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'init', text: source, version: 4, css, codeTheme: 'light-plus', baseUri: location.origin + '/', dialect: 'quarto', typewriterMode: false, zoomPercent: 100, readingWidthPercent: 180,
			} }));
		}, fixedThemeCss);
		await page.waitForTimeout(160);
		const fixedTheme = await snapshot(page);
		const fixedThemeStyle = await page.locator('#mlp-user-css').textContent();
		assert(fixedThemeStyle?.includes('max-width: var(--mlp-reading-column-max-width, calc(980px * var(--mlp-reading-width, 1)))'), 'finite theme width was not adapted through the CSS variable', { fixedThemeStyle });
		assert(Number.parseFloat(fixedTheme.maxWidth) > 980, '180% reading width did not expand a finite 980px theme column', { fixedTheme });

		await page.evaluate((css) => {
			const source = window.__mlpTestSourceText || '';
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'init', text: source, version: 5, css, codeTheme: 'light-plus', baseUri: location.origin + '/', dialect: 'quarto', typewriterMode: false, zoomPercent: 100, readingWidthPercent: 'full',
			} }));
		}, fixedThemeCss);
		await settle(page);
		const fullFixedTheme = await snapshot(page);
		assert(fullFixedTheme.readingWidthState === 'full' && fullFixedTheme.readingColumnMaxWidth === 'none' && fullFixedTheme.maxWidth === 'none' && fullFixedTheme.transform === 'none', 'Full mode did not remove an adapted finite theme cap safely', { fullFixedTheme });

		const builtInThemeResults = [];
		for (const [name, cssPromise] of builtInThemes) {
			const css = await cssPromise;
			await page.evaluate(({ css, name }) => {
				const source = window.__mlpTestSourceText || '';
				window.dispatchEvent(new MessageEvent('message', { data: {
					type: 'init', text: source, version: 10 + name.length, css, codeTheme: 'light-plus', baseUri: location.origin + '/', dialect: 'quarto', typewriterMode: false, zoomPercent: 100, readingWidthPercent: 'full',
				} }));
			}, { css, name });
			await settle(page);
			const state = await snapshot(page);
			assert(state.readingWidthState === 'full' && state.transform === 'none' && state.contentWidth > 0, `Full mode failed for built-in theme ${name}`, { name, state });
			builtInThemeResults.push({ name, readingWidthState: state.readingWidthState, maxWidth: state.maxWidth, contentWidth: state.contentWidth });
		}

		const unsupportedThemeCss = [
			'body { max-width: 100%; }',
			'body { max-width: none; }',
			'body { max-width: 80vw; }',
			'body { max-width: min(100%, 980px); }',
			'body { max-width: clamp(40rem, 80vw, 980px); }',
		].join('\n');
		await page.evaluate((css) => {
			const source = window.__mlpTestSourceText || '';
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'init', text: source, version: 20, css, codeTheme: 'light-plus', baseUri: location.origin + '/', dialect: 'quarto', typewriterMode: false, zoomPercent: 100, readingWidthPercent: 'full',
			} }));
		}, unsupportedThemeCss);
		await page.waitForTimeout(160);
		const unsupportedThemeStyle = await page.locator('#mlp-user-css').textContent();
		const unsupportedTheme = await snapshot(page);
		assert(!unsupportedThemeStyle?.includes('--mlp-reading-column-max-width'), 'unsupported theme width syntax was rewritten into a Full override', { unsupportedThemeStyle });
		assert(unsupportedTheme.readingWidthState === 'full' && unsupportedTheme.readingColumnMaxWidth === 'none', 'Full state was lost while applying unsupported theme widths', { unsupportedTheme });
		assert(unsupportedTheme.transform === 'none', 'unsupported width theme introduced a transform', { unsupportedTheme });

		assert(pageErrors.length === 0, 'browser page errors occurred', { pageErrors });
		console.log(JSON.stringify({ ok: true, initial, focusedAfter, afterCtrlWheel, width170, width180, full, fullAgain, fullTypography, widthMaximum, fullWideState, fullNarrowState, fontMaximum, fontMinimum, widthMinimum, resetState, fullBeforeReset, widthResetState, unfocused, reinitialized, fullReinitialized, fixedTheme, fullFixedTheme, builtInThemeResults, unsupportedTheme }));
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
