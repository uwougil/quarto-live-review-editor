#!/usr/bin/env node

/*
 * Issue #33 regression: rendered footnotes must be resolved from the visual
 * row that is actually under the pointer/caret. This deliberately exercises
 * the real CodeMirror EditorView in Chromium at the widths and document zooms
 * that make a source-contiguous footnote cluster cross visual rows.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIDTHS = [420, 600, 800, 1000];
const ZOOMS = [70, 100, 150];

function insideRepo(candidate) {
	const relative = path.relative(REPO, candidate);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function mimeType(filePath) {
	return {
		'.css': 'text/css; charset=utf-8',
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.map': 'application/json; charset=utf-8',
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
			response.writeHead(error?.code === 'ENOENT' ? 404 : 500);
			response.end(error?.code === 'ENOENT' ? 'not found' : String(error));
		}
	});
}

function assert(condition, message, details = {}) {
	if (!condition) throw new Error(JSON.stringify({ message, ...details }));
}

async function inspectGeometry(page) {
	await page.evaluate(() => {
		const line = [...document.querySelectorAll('.cm-line')].find((candidate) => candidate.textContent?.includes('FOOTNOTE-CARET-START'));
		line?.scrollIntoView({ block: 'center', inline: 'nearest' });
	});
	await page.waitForTimeout(60);
	return page.evaluate(() => {
		const line = [...document.querySelectorAll('.cm-line')].find((candidate) => candidate.textContent?.includes('FOOTNOTE-CARET-START'));
		if (!line) throw new Error('footnote caret fixture line is not mounted');
		const buttonEntries = [...line.querySelectorAll('.mlp-footnote-ref')].map((button) => {
			const rect = button.getBoundingClientRect();
			return {
				from: Number(button.dataset.referenceFrom),
				to: Number(button.dataset.referenceTo),
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				center: (rect.top + rect.bottom) / 2,
			};
		});
		const textEntries = [];
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		let node;
		while ((node = walker.nextNode())) {
			if (node.parentElement?.closest('.mlp-footnote-ref')) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			for (const rect of [...range.getClientRects()]) {
				if (rect.width <= 1 || rect.height <= 1) continue;
				textEntries.push({
					left: rect.left,
					right: rect.right,
					top: rect.top,
					bottom: rect.bottom,
					center: (rect.top + rect.bottom) / 2,
				});
			}
		}
		const groupRows = (entries) => {
			const rows = [];
			for (const entry of entries.sort((a, b) => a.center - b.center || a.left - b.left)) {
				const row = rows.at(-1);
				if (row && Math.abs(row.center - entry.center) <= 2) {
					row.left = Math.min(row.left, entry.left);
					row.right = Math.max(row.right, entry.right);
					row.top = Math.min(row.top, entry.top);
					row.bottom = Math.max(row.bottom, entry.bottom);
					row.center = (row.top + row.bottom) / 2;
				} else {
					rows.push({ ...entry });
				}
			}
			return rows;
		};
		const footnoteRows = [];
		for (const entry of buttonEntries) {
			let row = footnoteRows.find((candidate) => Math.abs(candidate.center - entry.center) <= 2);
			if (!row) {
				row = { center: entry.center, left: entry.left, right: entry.right, entries: [] };
				footnoteRows.push(row);
			}
			row.entries.push(entry);
			row.left = Math.min(row.left, entry.left);
			row.right = Math.max(row.right, entry.right);
			row.center = row.entries.reduce((sum, item) => sum + item.center, 0) / row.entries.length;
		}
		footnoteRows.sort((a, b) => a.center - b.center);
		return {
			source: window.__mlpTestSourceText || '',
			footnoteRows,
			textRows: groupRows(textEntries),
			lineHeight: Number.parseFloat(getComputedStyle(line).lineHeight),
		};
	});
}

function pointForRow(targetRow, textRow, side) {
	const targetX = side === 'left' ? targetRow.left + 1 : targetRow.right - 1;
	const left = textRow.left + 1;
	const right = textRow.right - 1;
	return { x: Math.max(left, Math.min(right, targetX)), y: textRow.center };
}

function expectedBoundaryForPoint(row, point) {
	const entry = row.entries.reduce((best, candidate) => {
		const bestDistance = point.x < best.left ? best.left - point.x : point.x > best.right ? point.x - best.right : 0;
		const candidateDistance = point.x < candidate.left ? candidate.left - point.x : point.x > candidate.right ? point.x - candidate.right : 0;
		return candidateDistance < bestDistance ? candidate : best;
	});
	return point.x <= (entry.left + entry.right) / 2 ? entry.from : entry.to;
}

async function moveFromTextRow(page, point, direction) {
	await page.evaluate(() => window.__mlpDebugSetSelection?.(0));
	await page.waitForTimeout(80);
	await page.mouse.click(point.x, point.y);
	await page.waitForTimeout(50);
	const before = await page.evaluate(() => window.__mlpDebugSelection?.());
	await page.keyboard.press(direction);
	await page.waitForTimeout(50);
	const after = await page.evaluate(() => window.__mlpDebugSelection?.());
	return { point, before, after };
}

async function checkFirstPointerPlacement(page, geometry) {
	const point = await page.evaluate(() => {
		const line = [...document.querySelectorAll('.cm-line')].find((candidate) => candidate.textContent?.includes('FOOTNOTE-CARET-START'));
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		let node;
		while ((node = walker.nextNode())) {
			if (node.parentElement?.closest('.mlp-footnote-ref')) continue;
			const index = (node.nodeValue || '').indexOf('before');
			if (index < 0) continue;
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + 'before'.length);
			const rect = [...range.getClientRects()].at(-1);
			if (rect) return { x: rect.right - 1, y: (rect.top + rect.bottom) / 2 };
		}
		return null;
	});
	assert(point, 'plain prose probe is not mounted', { geometry });
	await page.evaluate(() => window.__mlpDebugSetSelection?.(0));
	await page.waitForTimeout(80);
	await page.mouse.move(point.x, point.y);
	await page.mouse.down();
	await page.waitForTimeout(20);
	const duringMouseDown = await page.evaluate(() => window.__mlpDebugSelection?.());
	await page.mouse.up();
	await page.waitForTimeout(60);
	const afterMouseUp = await page.evaluate(() => window.__mlpDebugSelection?.());
	const firstReferenceFrom = geometry.source.indexOf('[^r0]');
	return {
		point,
		duringMouseDown,
		afterMouseUp,
		stable: duringMouseDown?.head === afterMouseUp?.head,
		beforeFirstReference: duringMouseDown?.head < firstReferenceFrom,
	};
}

async function runCase(browser, baseUrl, width, zoom) {
	const page = await browser.newPage({ viewport: { width, height: 800 } });
	try {
		const url = new URL('/scripts/long-document-browser-harness.html', baseUrl);
		url.searchParams.set('footnoteCaret', '1');
		url.searchParams.set('zoom', String(zoom));
		await page.goto(url.toString(), { waitUntil: 'load' });
		await page.waitForFunction(() => window.__mlpLongDocumentResult !== undefined, null, { timeout: 30000 });
		const ready = await page.evaluate(() => window.__mlpLongDocumentResult);
		assert(ready.ok, 'EditorView failed to initialize', { ready, width, zoom });
		await page.waitForTimeout(120);
		const geometry = await inspectGeometry(page);
		assert(geometry.footnoteRows.length >= 1, 'fixture has no rendered footnote row', { width, zoom, geometry });
		const firstRow = geometry.footnoteRows[0];
		const lastRow = geometry.footnoteRows.at(-1);
		const rowSeparation = Math.max(geometry.lineHeight * 0.5, 1);
		const beforeRow = geometry.textRows.filter((row) => row.center < firstRow.center - rowSeparation).at(-1);
		const afterRow = geometry.textRows.find((row) => row.center > lastRow.center + rowSeparation);
		assert(beforeRow && afterRow, 'fixture lacks text rows around footnote cluster', { width, zoom, geometry });

		const down = {};
		for (const side of ['left', 'right']) {
			const point = pointForRow(firstRow, beforeRow, side);
			down[side] = {
				...(await moveFromTextRow(page, point, 'ArrowDown')),
				expected: expectedBoundaryForPoint(firstRow, point),
			};
		}
		const up = {};
		for (const side of ['left', 'right']) {
			const point = pointForRow(lastRow, afterRow, side);
			up[side] = {
				...(await moveFromTextRow(page, point, 'ArrowUp')),
				expected: expectedBoundaryForPoint(lastRow, point),
			};
		}
		const pointer = await checkFirstPointerPlacement(page, geometry);
		const checks = {
			arrowDownLeftUsesRowBoundary: down.left.after?.head === down.left.expected,
			arrowDownRightUsesRowBoundary: down.right.after?.head === down.right.expected,
			arrowUpLeftUsesRowBoundary: up.left.after?.head === up.left.expected,
			arrowUpRightUsesRowBoundary: up.right.after?.head === up.right.expected,
			firstPointerPlacementIsFinal: pointer.stable && pointer.beforeFirstReference,
		};
		return { width, zoom, ok: Object.values(checks).every(Boolean), checks, geometry: { footnoteRows: geometry.footnoteRows, textRows: geometry.textRows }, down, up, pointer };
	} finally {
		await page.close();
	}
}

async function main() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const browser = await chromium.launch({ headless: true });
	const results = [];
	try {
		for (const width of WIDTHS) {
			for (const zoom of ZOOMS) results.push(await runCase(browser, baseUrl, width, zoom));
		}
	} finally {
		await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
	const failed = results.filter((result) => !result.ok);
	process.stdout.write(JSON.stringify({ ok: failed.length === 0, widths: WIDTHS, zooms: ZOOMS, results }, null, 2) + '\n');
	if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
	process.stderr.write((error?.stack || String(error)) + '\n');
	process.exitCode = 1;
});
