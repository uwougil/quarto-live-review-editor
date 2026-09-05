#!/usr/bin/env node

/*
 * Deterministic geometry regression for one logical paragraph that wraps into
 * many visual rows. This test deliberately uses real Chromium mouse and
 * keyboard events; it never replaces CodeMirror's input handling.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INITIAL_THEMES = [null, 'vscode.css', 'github-light.css', 'claude.css', 'dark.css'];
const TARGET_SPECS = [
	{ key: 'top', marker: 'TARGET-TOP-START', next: 'FOLLOWING-TOP-START', reveal: [] },
	{ key: '25', marker: 'TARGET-25-START', next: 'FOLLOWING-25-START', reveal: [] },
	{ key: '50', marker: 'TARGET-50-START', next: 'FOLLOWING-50-START', reveal: ['**emphasis**', '[a link]', '$M_s$', '[^1]' ] },
	{ key: '75', marker: 'TARGET-75-START', next: 'FOLLOWING-75-START', reveal: [] },
	{ key: 'eof', marker: 'TARGET-EOF-START', next: null, reveal: [] },
];

function insideRepo(candidate) {
	const relative = path.relative(REPO, candidate);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function mimeType(filePath) {
	return {
		'.css': 'text/css; charset=utf-8',
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.svg': 'image/svg+xml',
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

async function runState(page, baseUrl, initialTheme) {
	const url = new URL('/scripts/long-document-browser-harness.html', baseUrl);
	url.searchParams.set('interaction', '1');
	if (initialTheme) url.searchParams.set('theme', initialTheme);
	await page.goto(url.toString(), { waitUntil: 'load' });
	await page.waitForFunction(() => window.__mlpLongDocumentResult !== undefined, null, { timeout: 30000 });
	const ready = await page.evaluate(() => window.__mlpLongDocumentResult);
	assert(ready.ok, 'EditorView failed to initialize', { ready });

	const sleep = (ms) => page.waitForTimeout(ms);
	const settle = async () => {
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		await sleep(60);
	};
	const source = await page.evaluate(() => window.__mlpTestSourceText || '');
	const boundaries = await page.evaluate((specs) => {
		const text = window.__mlpTestSourceText || '';
		return specs.map((spec) => {
			const targetFrom = text.indexOf(spec.marker);
			const targetLineEnd = text.indexOf('\n', targetFrom);
			const targetTo = targetLineEnd < 0 ? text.length : targetLineEnd;
			const nextParagraphFrom = spec.next ? text.indexOf(spec.next, targetTo) : text.length;
			return { ...spec, targetFrom, targetTo, nextParagraphFrom };
		});
	}, TARGET_SPECS);
	assert(boundaries.every((target) => target.targetFrom >= 0 && target.nextParagraphFrom >= target.targetTo), 'invalid source boundaries', { boundaries });
	for (const target of boundaries) {
		const ratio = target.targetFrom / Math.max(1, source.length);
		if (target.key === 'top') assert(ratio < 0.1, 'top target is not near document start', { target, ratio });
		if (target.key === '25') assert(ratio > 0.15 && ratio < 0.35, '25 percent target has unexpected depth', { target, ratio });
		if (target.key === '50') assert(ratio > 0.35 && ratio < 0.65, '50 percent target has unexpected depth', { target, ratio });
		if (target.key === '75') assert(ratio > 0.65 && ratio < 0.85, '75 percent target has unexpected depth', { target, ratio });
		if (target.key === 'eof') assert(ratio > 0.85, 'EOF target is not near document end', { target, ratio });
	}

	const setCursor = async (pos) => {
		await page.evaluate((value) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setCursor', pos: value } })), pos);
		await settle();
	};
	const showTarget = async (target) => {
		await page.evaluate((pos) => window.__mlpDebugScrollToPosition?.(pos), target.targetFrom);
		await settle();
	};
	const bringRowIntoMouseRange = async (row) => {
		if (row.center >= 60 && row.center <= 740) return;
		await page.evaluate((delta) => {
			const scroller = document.querySelector('.cm-scroller');
			if (scroller) scroller.scrollTop += delta;
		}, row.center - 400);
		await settle();
	};

	const geometry = async (target) => page.evaluate((marker) => {
		const source = window.__mlpTestSourceText || '';
		const line = [...document.querySelectorAll('.cm-line')].find((candidate) => candidate.textContent?.includes(marker));
		if (!line) throw new Error(`target .cm-line is not mounted: ${marker}`);
		const style = getComputedStyle(line);
		const parsedLineHeight = Number.parseFloat(style.lineHeight);
		const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : 20;
		const threshold = Math.max(5, lineHeight * 0.65);
		const range = document.createRange();
		range.selectNodeContents(line);
		const fragments = [...range.getClientRects()]
			.filter((rect) => rect.width > 1 && rect.height > 1)
			.map((rect) => ({
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				center: (rect.top + rect.bottom) / 2,
			}))
			.sort((a, b) => a.center - b.center || a.left - b.left);
		const rows = [];
		for (const fragment of fragments) {
			const row = rows[rows.length - 1];
			if (row && fragment.center - row.center <= threshold) {
				row.left = Math.min(row.left, fragment.left);
				row.right = Math.max(row.right, fragment.right);
				row.top = Math.min(row.top, fragment.top);
				row.bottom = Math.max(row.bottom, fragment.bottom);
				row.center = (row.top + row.bottom) / 2;
				row.fragments.push(fragment);
			} else {
				rows.push({ left: fragment.left, right: fragment.right, top: fragment.top, bottom: fragment.bottom, center: fragment.center, fragments: [fragment] });
			}
		}
		return {
			rows: rows.map((row) => {
				const textFragment = [...row.fragments].sort((a, b) => (b.right - b.left) - (a.right - a.left))[0];
				return {
					left: row.left,
					right: row.right,
					top: row.top,
					bottom: row.bottom,
					center: row.center,
					width: row.right - row.left,
					probeX: (textFragment.left + textFragment.right) / 2,
					height: row.bottom - row.top,
				};
			}),
			targetRect: (() => {
				const rect = line.getBoundingClientRect();
				return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
			})(),
			lineHeight,
			computed: {
				lineHeight: style.lineHeight,
				paddingTop: style.paddingTop,
				paddingBottom: style.paddingBottom,
				fontSize: style.fontSize,
			},
			sourceLength: source.length,
		};
	}, target.marker);

	const selection = async () => page.evaluate(() => window.__mlpDebugSelection?.());
	const rowForCaret = (rows, value) => {
		if (!value || value.y === null) return -1;
		const center = value.y + value.defaultLineHeight / 2;
		let best = -1;
		let distance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < rows.length; i++) {
			const candidate = Math.abs(rows[i].center - center);
			if (candidate < distance) {
				best = i;
				distance = candidate;
			}
		}
		return best;
	};

	const mouseCase = async (label, target) => {
		const probes = [];
		await setCursor(0);
		await showTarget(target);
		const initialGeometry = await geometry(target);
		assert(initialGeometry.rows.length >= 8, 'target did not wrap into enough visual rows', { label, rows: initialGeometry.rows.length });
		for (let rowIndex = 0; rowIndex < initialGeometry.rows.length; rowIndex++) {
			await setCursor(0);
			await showTarget(target);
			let current = await geometry(target);
			let row = current.rows[rowIndex];
			assert(row, 'visual row disappeared before mouse probe', { label, rowIndex, current });
			await bringRowIntoMouseRange(row);
			current = await geometry(target);
			row = current.rows[rowIndex];
			assert(row, 'visual row disappeared after scrolling for mouse probe', { label, rowIndex, current });
			await page.mouse.click(row.probeX, row.center);
			await sleep(80);
			const value = await selection();
			const caretCenter = value?.y === null || value?.y === undefined ? null : value.y + value.defaultLineHeight / 2;
			const tolerance = Math.max(current.lineHeight * 0.75, row.height * 0.75);
			const sourceInside = Boolean(value && value.head >= target.targetFrom && value.head <= target.targetTo);
			const visualInside = caretCenter !== null && Math.abs(caretCenter - row.center) <= tolerance;
			probes.push({ rowIndex, clicked: { x: row.probeX, y: row.center }, selection: value, caretCenter, sourceInside, visualInside, delta: caretCenter === null ? null : caretCenter - row.center });
		}
		assert(probes.every((probe) => probe.sourceInside), 'mouse caret escaped exact target source interval', { label, target, probes });
		assert(probes.every((probe) => probe.visualInside), 'mouse caret landed in a different visual row', { label, target, probes });
		return { label, rowCount: initialGeometry.rows.length };
	};

	const arrowCase = async (label, target, revealInlineSyntax) => {
		if (revealInlineSyntax) {
			for (const marker of target.reveal) {
				const position = source.indexOf(marker, target.targetFrom);
				if (position >= target.targetFrom && position < target.targetTo) await setCursor(position + Math.min(2, marker.length));
			}
		}
		await setCursor(target.targetFrom);
		await showTarget(target);
		let current = await geometry(target);
		assert(current.rows.length >= 8, 'source-revealed target did not wrap into enough visual rows', { label, current });
		const first = current.rows[0];
		await page.mouse.click(first.probeX, first.center);
		await sleep(80);
		let value = await selection();
		let rowIndex = rowForCaret(current.rows, value);
		assert(rowIndex === 0, 'arrow case did not start on the first visual row', { label, rowIndex, value, current });
		const down = [];
		for (let expected = 1; expected < current.rows.length; expected++) {
			await page.keyboard.press('ArrowDown');
			await sleep(35);
			value = await selection();
			current = await geometry(target);
			rowIndex = rowForCaret(current.rows, value);
			const sourceInside = Boolean(value && value.head >= target.targetFrom && value.head <= target.targetTo);
			down.push({ expected, rowIndex, sourceInside, selection: value });
			assert(sourceInside, 'ArrowDown escaped the exact target source interval', { label, expected, rowIndex, value, target, current, down });
			assert(rowIndex === expected, 'ArrowDown skipped or repeated a visual row', { label, expected, rowIndex, value, boundaries, current, down });
		}
		const up = [];
		for (let expected = current.rows.length - 2; expected >= 0; expected--) {
			await page.keyboard.press('ArrowUp');
			await sleep(35);
			value = await selection();
			current = await geometry(target);
			rowIndex = rowForCaret(current.rows, value);
			const sourceInside = Boolean(value && value.head >= target.targetFrom && value.head <= target.targetTo);
			up.push({ expected, rowIndex, sourceInside, selection: value });
			assert(sourceInside, 'ArrowUp escaped the exact target source interval', { label, expected, rowIndex, value, target, current, up });
			assert(rowIndex === expected, 'ArrowUp skipped or repeated a visual row', { label, expected, rowIndex, value, boundaries, current, up });
		}
		return { label, rowCount: current.rows.length };
	};

	const runStateCases = async (label) => {
		const targets = [];
		for (const target of boundaries) {
			await setCursor(0);
			await showTarget(target);
			const initial = await geometry(target);
			const block = await page.evaluate((pos) => window.__mlpDebugLineBlock?.(pos), target.targetFrom);
			// Clicking a source-reveal target legitimately changes its inline width,
			// so its rendered mouse rows are not stable across the click itself. The
			// plain targets cover the exact per-row mouse contract at every depth;
			// the reveal target is exercised by the keyboard case below.
			const renderedMouse = target.reveal.length === 0
				? await mouseCase(`${label}:${target.key}:rendered-mouse`, target)
				: null;
			const revealedArrow = await arrowCase(`${label}:${target.key}:arrows`, target, target.reveal.length > 0);
			const initialInvariant = block && Math.abs(block.height - initial.targetRect.height) <= 1;
			assert(initialInvariant, 'CodeMirror lineBlock height differs from DOM target height', { label, target, block, initial });
			targets.push({ key: target.key, depthRatio: target.targetFrom / Math.max(1, source.length), rowCount: initial.rows.length, initialInvariant, renderedMouse, revealedArrow });
		}
		return { label, targets };
	};

	const before = await runStateCases(initialTheme || 'default');
	const runtimeTheme = initialTheme === 'dark.css' ? 'github-light.css' : 'dark.css';
	const runtimeCss = await page.evaluate(async (name) => {
		const response = await fetch('/media/sample-styles/' + name);
		return response.text();
	}, runtimeTheme);
	await page.evaluate((css) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'applyCss', css } })), runtimeCss);
	await settle();
	const after = await runStateCases((initialTheme || 'default') + ':runtime-' + runtimeTheme);
	await page.close();
	return { initialTheme: initialTheme || 'default', runtimeTheme, before, after };
}

async function main() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	const baseUrl = 'http://127.0.0.1:' + port;
	const browser = await chromium.launch({ headless: true });
	const results = [];
	try {
		for (const theme of INITIAL_THEMES) {
			const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
			results.push(await runState(page, baseUrl, theme));
		}
	} finally {
		await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
	process.stdout.write(JSON.stringify({ ok: true, results }, null, 2) + '\n');
}

main().catch((error) => {
	process.stderr.write((error?.stack || String(error)) + '\n');
	process.exitCode = 1;
});
