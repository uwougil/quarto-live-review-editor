#!/usr/bin/env node

/**
 * Real-Chromium regression for "Normalize math on paste" (Issue #53).
 *
 * Drives the actual built webview bundle through real `paste` DOM events so the
 * clipboard path, the CodeMirror paste handler and the single-transaction
 * guarantee are all exercised for real rather than through a mock.
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

async function settle(page, delay = 30) {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	if (delay) await page.waitForTimeout(delay);
}

/** Fixture with a fenced code block, so "paste inside a fence" can be tested. */
function sourceFixture() {
	return ['ALPHA', '```python', 'code_line = 1', '```', 'OMEGA'].join('\n');
}

async function init(page, text, normalizeMathOnPaste) {
	await page.evaluate(({ text, normalizeMathOnPaste }) => {
		window.__mlpTestSourceText = text;
		// Messages are replayed from scratch for every scenario so an assertion can
		// talk about "the edits this paste produced" without bookkeeping offsets.
		window.__mlpPostedMessages.length = 0;
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'init', text, version: Date.now(), css: '', codeTheme: 'light-plus',
			baseUri: location.origin + '/', dialect: 'markdown', typewriterMode: false,
			normalizeMathOnPaste, zoomPercent: 100,
		} }));
	}, { text, normalizeMathOnPaste });
	await page.waitForFunction((length) => window.__mlpDebugSnapshot?.()?.docLength === length, text.length, { timeout: 10000 });
	await settle(page);
}

/**
 * Dispatches a real paste event on the editor content with the given clipboard
 * text, then waits for the host message it produces.
 *
 * The webview debounces outbound edits by 250ms, so a fixed sleep would be both
 * slow and flaky; waiting on the message itself is exact.
 */
async function paste(page, clipboardText) {
	return page.evaluate(async (clip) => {
		const target = document.querySelector('.cm-content');
		if (!target) throw new Error('editor content element is missing');
		const data = new DataTransfer();
		data.setData('text/plain', clip);
		let event;
		try {
			event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
			if (!event.clipboardData) throw new Error('clipboardData was not accepted');
		} catch {
			// Some engines refuse `clipboardData` in the init dict; inject it instead.
			event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', { value: data, configurable: true });
		}
		const before = window.__mlpPostedMessages.length;
		target.dispatchEvent(event);
		const deadline = Date.now() + 4000;
		while (Date.now() < deadline && window.__mlpPostedMessages.length === before) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return { prevented: event.defaultPrevented, produced: window.__mlpPostedMessages.length - before };
	}, clipboardText);
}

async function readState(page) {
	return page.evaluate(() => ({
		doc: window.__mlpDebugDocText?.() ?? null,
		messages: window.__mlpPostedMessages.slice(),
	}));
}

/** All text inserted by the `edit` messages recorded since the last `init`. */
function insertedText(state) {
	return state.messages
		.filter((message) => message.type === 'edit')
		.flatMap((message) => message.changes.map((change) => change.insert))
		.join('');
}

function editCount(state) {
	return state.messages.filter((message) => message.type === 'edit').length;
}

async function main() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(String(error)));

	const results = {};
	try {
		await page.goto(`${baseUrl}/scripts/long-document-browser-harness.html?probe=1`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.__mlpLongDocumentResult !== undefined, null, { timeout: 30000 });

		const source = sourceFixture();

		// 1. Enabled: inline delimiters are normalized, and the whole paste is one edit.
		await init(page, source, true);
		await page.evaluate(() => window.__mlpDebugSetSelection?.(0, 5));
		await paste(page, 'Pasted \\(E = mc^2\\) here');
		await settle(page);
		const enabled = await readState(page);
		assert(editCount(enabled) === 1, 'normalized paste must produce exactly one edit (one undo)', { edits: enabled.messages.filter((m) => m.type === 'edit') });
		assert(insertedText(enabled) === 'Pasted $E = mc^2$ here', 'inline delimiters were not normalized', { inserted: insertedText(enabled) });
		assert(enabled.doc === 'Pasted $E = mc^2$ here' + source.slice(5), 'document text is wrong after paste', { doc: enabled.doc });
		results.enabledInline = { inserted: insertedText(enabled), edits: editCount(enabled) };

		// 2. Disabled: the same paste stays exactly as copied.
		await init(page, source, false);
		await page.evaluate(() => window.__mlpDebugSetSelection?.(0, 5));
		await paste(page, 'Pasted \\(E = mc^2\\) here');
		await settle(page);
		const disabled = await readState(page);
		assert(insertedText(disabled) === 'Pasted \\(E = mc^2\\) here', 'disabled setting must paste the raw text', { inserted: insertedText(disabled) });
		results.disabledInline = insertedText(disabled);

		// 3. Enabled: a display formula becomes a block over its own lines.
		await init(page, 'A\nB', true);
		await page.evaluate(() => window.__mlpDebugSetSelection?.(2));
		await paste(page, '\\[E = mc^2\\]');
		await settle(page);
		const block = await readState(page);
		assert(insertedText(block) === '$$\nE = mc^2\n$$\n', 'display delimiters were not normalized', { inserted: insertedText(block) });
		assert(block.doc === 'A\n$$\nE = mc^2\n$$\nB', 'display paste at a line start must isolate the closing delimiter', { doc: block.doc });
		results.block = insertedText(block);

		// 4. Enabled, but the caret sits inside an existing code fence: stay literal.
		await init(page, source, true);
		const fencePos = source.indexOf('code_line') + 2;
		await page.evaluate((pos) => window.__mlpDebugSetSelection?.(pos), fencePos);
		await paste(page, '\\(x\\)');
		await settle(page);
		const fenced = await readState(page);
		assert(insertedText(fenced) === '\\(x\\)', 'paste inside a fenced code block must stay literal', { inserted: insertedText(fenced) });
		results.insideFence = insertedText(fenced);

		// 5. Every protected destination context keeps the pasted delimiters literal.
		const protectedDestinations = [
			{
				name: 'inlineCode',
				source: 'Use `HERE` as the input string.',
				position: 'Use `HERE` as the input string.'.indexOf('HERE'),
			},
			{
				name: 'inlineMath',
				source: '$a HERE b$',
				position: '$a HERE b$'.indexOf('HERE'),
			},
			{
				name: 'displayMath',
				source: '$$\na HERE b\n$$',
				position: '$$\na HERE b\n$$'.indexOf('HERE'),
			},
		];
		for (const destination of protectedDestinations) {
			await init(page, destination.source, true);
			await page.evaluate((pos) => window.__mlpDebugSetSelection?.(pos), destination.position);
			await paste(page, '\\(x\\)');
			await settle(page);
			const protectedState = await readState(page);
			assert(insertedText(protectedState) === '\\(x\\)', `${destination.name} destination must keep paste literal`, { inserted: insertedText(protectedState) });
			assert(protectedState.doc === destination.source.slice(0, destination.position) + '\\(x\\)' + destination.source.slice(destination.position), `${destination.name} destination changed unexpectedly`, { doc: protectedState.doc });
			results[destination.name] = insertedText(protectedState);
		}

		// 6. Display math pasted in prose must have standalone delimiter lines.
		const midLineSource = 'foo HERE bar';
		const midLinePosition = midLineSource.indexOf('HERE');
		await init(page, midLineSource, true);
		await page.evaluate((pos) => window.__mlpDebugSetSelection?.(pos, pos + 4), midLinePosition);
		await paste(page, '\\[E = mc^2\\]');
		await settle(page);
		const midLine = await readState(page);
		const expectedMidLine = 'foo \n$$\nE = mc^2\n$$\n bar';
		assert(midLine.doc === expectedMidLine, 'mid-line display paste must isolate both $$ delimiters on their own lines', { doc: midLine.doc });
		assert(insertedText(midLine) === '\n$$\nE = mc^2\n$$\n', 'display paste should include only the contextual boundary newlines in its edit payload', { inserted: insertedText(midLine) });
		results.midLineDisplay = midLine.doc;

		// 7. Existing line boundaries must not gain unnecessary blank lines.
		const displayBoundaryCases = [
			{ name: 'lineStart', source: 'bar', position: 0, expected: '$$\nE\n$$\nbar' },
			{ name: 'lineEnd', source: 'foo ', position: 4, expected: 'foo \n$$\nE\n$$' },
			{ name: 'emptyLine', source: 'before\n\nafter', position: 'before\n'.length, expected: 'before\n$$\nE\n$$\nafter' },
		];
		for (const testCase of displayBoundaryCases) {
			await init(page, testCase.source, true);
			await page.evaluate((pos) => window.__mlpDebugSetSelection?.(pos), testCase.position);
			await paste(page, '\\[E\\]');
			await settle(page);
			const boundary = await readState(page);
			assert(editCount(boundary) === 1, `${testCase.name} display paste must produce exactly one edit`, { edits: boundary.messages.filter((message) => message.type === 'edit') });
			assert(boundary.doc === testCase.expected, `${testCase.name} display paste has incorrect line boundaries`, { doc: boundary.doc });
			results[testCase.name] = boundary.doc;
		}

		// 8. Replacing a prose selection uses the same source-safe placement rule.
		const replacementSource = 'foo HERE bar';
		await init(page, replacementSource, true);
		await page.evaluate((pos) => window.__mlpDebugSetSelection?.(pos, pos + 4), replacementSource.indexOf('HERE'));
		await paste(page, '\\[E\\]');
		await settle(page);
		const replacement = await readState(page);
		assert(editCount(replacement) === 1, 'display replacement paste must produce exactly one edit', { edits: replacement.messages.filter((message) => message.type === 'edit') });
		assert(replacement.doc === 'foo \n$$\nE\n$$\n bar', 'mid-line replacement display paste must isolate delimiters', { doc: replacement.doc });
		results.replacementDisplay = replacement.doc;

		// 9. Pastes without LaTeX delimiters keep CodeMirror's own behavior.
		await init(page, 'A\nB', true);
		await page.evaluate(() => window.__mlpDebugSetSelection?.(2));
		await paste(page, 'plain $x$ text');
		await settle(page);
		const plain = await readState(page);
		assert(insertedText(plain) === 'plain $x$ text', 'non-LaTeX paste must go through the built-in handler untouched', { inserted: insertedText(plain) });
		results.plainPaste = insertedText(plain);

		assert(pageErrors.length === 0, 'browser page errors occurred', { pageErrors });
		console.log(JSON.stringify({ ok: true, ...results }, null, 2));
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
