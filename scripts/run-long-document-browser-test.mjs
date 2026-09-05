#!/usr/bin/env node

/** Run the real EditorView long-document regression in Chromium. */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
	const args = { baseline: false, synthetic: false, full: false, benchmark: false, probe: false, inlineGeometry: false, footnoteInteraction: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--baseline') args.baseline = true;
		else if (arg === '--synthetic') args.synthetic = true;
		else if (arg === '--full') args.full = true;
		else if (arg === '--benchmark') args.benchmark = true;
		else if (arg === '--probe') args.probe = true;
		else if (arg === '--inline-geometry') args.inlineGeometry = true;
		else if (arg === '--inline-interaction') args.footnoteInteraction = true;
		else if (arg === '--interaction') args.interaction = true;
		else if (['--source', '--theme', '--bundle'].includes(arg)) {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a value`);
			args[arg.slice(2)] = value;
		} else throw new Error(`unknown argument: ${arg}`);
	}
	return args;
}

function insideRepo(candidate) {
	const relative = path.relative(REPO, candidate);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function mimeType(filePath) {
	return {
		'.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
		'.png': 'image/png', '.gif': 'image/gif', '.qmd': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
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

function queryFor(baseUrl, args, benchmarkLines, sourcePath) {
	const query = new URLSearchParams();
	if (benchmarkLines !== null) query.set('lines', String(benchmarkLines));
	else if (sourcePath) query.set('source', sourcePath);
	if (args.bundle) query.set('bundle', args.bundle);
	if (args.theme) query.set('theme', args.theme);
	if (args.baseline) query.set('baseline', '1');
	if (args.probe) query.set('probe', '1');
	if (args.inlineGeometry) query.set('inline', '1');
	if (args.footnoteInteraction) query.set('footnoteInteraction', '1');
	if (args.interaction) query.set('interaction', '1');
	return `${baseUrl}?${query}`;
}

function compactSnapshot(snapshot) {
	if (!snapshot) return null;
	const keys = ['docLength', 'docLines', 'viewport', 'contentHeight', 'scrollTop', 'scrollHeight', 'clientHeight', 'domLineCount', 'syntaxTreeLength', 'syntaxTreeAvailableToViewport', 'syntaxTreeAvailableToDocument', 'syntaxParserRunning', 'decorationRebuildCount'];
	return Object.fromEntries(keys.map((key) => [key, snapshot[key]]));
}

function compactResult(item) {
	return {
		ok: item.ok, baseline: item.baseline, sourceKind: item.sourceKind, sourceLength: item.sourceLength, sourceLines: item.sourceLines,
		browserElapsedMs: item.browserElapsedMs, initial: compactSnapshot(item.initial),
		samples: (item.samples || []).map((sample) => ({ label: sample.label, parserCaughtUp: sample.parserCaughtUp, snapshot: compactSnapshot(sample.snapshot) })),
		eof: { parserCaughtUp: item.eof?.parserCaughtUp, snapshot: compactSnapshot(item.eof?.snapshot) },
		markers: (item.markers || []).map((marker) => Object.fromEntries(['label', 'found', 'pos', 'viewportContains', 'domContainsMarker'].map((key) => [key, marker[key]]))),
		final: compactSnapshot(item.final), markerFailures: item.markerFailures, pageErrors: item.pageErrors, error: item.error,
		interaction: item.interaction ? { checks: item.interaction.checks, initialDiagnostics: item.interaction.initialDiagnostics } : undefined,
		footnoteInteraction: item.footnoteInteraction ? { checks: item.footnoteInteraction.checks, traceCount: item.footnoteInteraction.traceCount } : undefined,
	};
}

function benchmarkResult(items) {
	return {
		ok: items.every((item) => item.ok),
		runs: items.map((item) => ({
			sourceKind: item.sourceKind, lines: item.sourceLines, characters: item.sourceLength, readyMs: item.readyMs,
			scrollMs: (item.samples || []).map((sample) => sample.elapsedMs), eofMs: item.eof?.elapsedMs,
			parserCaughtUp: (item.samples || []).map((sample) => sample.parserCaughtUp).concat(item.eof?.parserCaughtUp),
			domLineCounts: (item.samples || []).map((sample) => sample.snapshot?.domLineCount),
			maxDecorationRebuilds: Math.max(0, ...(item.samples || []).map((sample) => sample.snapshot?.decorationRebuildCount || 0), item.eof?.snapshot?.decorationRebuildCount || 0),
			longTaskCount: item.longTaskCount || 0, longTaskTotalMs: item.longTaskTotalMs || 0, pageErrors: item.pageErrors || [],
		})),
	};
}

async function runFootnoteInteraction(page, text) {
	const references = [1, 2, 3, 4].map((ordinal) => {
		const token = `[^${ordinal}]`;
		const from = text.indexOf(token);
		return { ordinal, from, to: from + token.length };
	});
	const definitionHeads = [1, 2, 3, 4].map((ordinal) => text.indexOf(`[^${ordinal}]:`));
	if (references.some((reference) => reference.from < 0) || definitionHeads.some((head) => head < 0)) {
		throw new Error('footnote interaction fixture positions were not found');
	}

	await page.evaluate((ranges) => {
		const findLine = () => [...document.querySelectorAll('.cm-line')].find((line) => line.textContent?.includes('FOOTNOTE-INTERACTION-START')) || null;
		const rectData = (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 });
		const textRect = (needle) => {
			const root = findLine();
			if (!root) return null;
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node;
			while ((node = walker.nextNode())) {
				const value = node.nodeValue || '';
				const index = value.indexOf(needle);
				if (index < 0) continue;
				const range = document.createRange();
				range.setStart(node, index);
				range.setEnd(node, index + needle.length);
				const rect = [...range.getClientRects()].find((candidate) => candidate.width > 1 && candidate.height > 1);
				if (rect) return rectData(rect);
			}
			return null;
		};
		window.__mlpFootnoteInteraction = {
			scrollLine() {
				const line = findLine();
				if (!line) return false;
				line.scrollIntoView({ block: 'center', inline: 'nearest' });
				return true;
			},
			textRect,
			buttonRect(ordinal) {
				const button = [...document.querySelectorAll('.mlp-footnote-ref')].find((candidate) => candidate.textContent?.trim() === String(ordinal));
				if (!(button instanceof HTMLElement)) return null;
				button.scrollIntoView({ block: 'center', inline: 'nearest' });
				return rectData(button.getBoundingClientRect());
			},
			backRect() {
				const button = document.querySelector('.mlp-footnote-back');
				if (!(button instanceof HTMLElement)) return null;
				button.scrollIntoView({ block: 'center', inline: 'nearest' });
				return rectData(button.getBoundingClientRect());
			},
			state() {
				const line = findLine();
				const lineText = line?.textContent || '';
				const rawSourceTokens = ranges.filter((range) => lineText.includes(`[^${range.ordinal}]`)).map((range) => range.ordinal);
				const widgetOrdinals = [...(line?.querySelectorAll('.mlp-footnote-ref') || [])].map((button) => Number(button.textContent));
				const selection = window.__mlpDebugSelection?.() || null;
				const selectionInsideReferences = selection ? ranges.filter((range) => selection.head > range.from && selection.head < range.to).map((range) => range.ordinal) : [];
				return { linePresent: Boolean(line), lineText, rawSourceTokens, widgetOrdinals, activeSourceCount: rawSourceTokens.length, selectionInsideReferences, selection };
			},
		};
	}, references);

	const settle = () => page.waitForTimeout(80);
	const apiState = () => page.evaluate(() => window.__mlpFootnoteInteraction?.state());
	const scrollLine = async () => {
		if (!(await page.evaluate(() => window.__mlpFootnoteInteraction?.scrollLine()))) throw new Error('footnote interaction paragraph is not in the DOM');
		await page.waitForTimeout(40);
	};
	const traces = [];
	const record = async (label) => {
		const state = await apiState();
		traces.push({ label, state });
		return state;
	};
	const ordinaryState = (state) => Boolean(state && state.linePresent && state.activeSourceCount === 0 && state.widgetOrdinals.length === 4 && state.selectionInsideReferences.length === 0);
	const clickText = async (needle, side) => {
		await scrollLine();
		const rect = await page.evaluate((value) => window.__mlpFootnoteInteraction?.textRect(value), needle);
		if (!rect) throw new Error(`text rect not found for ${needle}`);
		const x = side === 'end' ? Math.max(rect.left + 1, rect.right - 2) : Math.min(rect.right - 1, rect.left + 2);
		await page.mouse.click(x, rect.y);
		await settle();
		return { x, y: rect.y };
	};

	await scrollLine();
	const initial = await record('initial');
	const beforeProseClick = await clickText('spintronics', 'end');
	const afterProseClick = await record('prose-immediately-before-cluster');

	const down = [];
	for (let i = 0; i < 8; i += 1) {
		await page.keyboard.press('ArrowDown');
		await settle();
		down.push(await record(`ArrowDown-${i + 1}`));
	}
	const up = [];
	for (let i = 0; i < 8; i += 1) {
		await page.keyboard.press('ArrowUp');
		await settle();
		up.push(await record(`ArrowUp-${i + 1}`));
	}

	const horizontalRight = [];
	await clickText('spintronics', 'end');
	for (let i = 0; i < 8; i += 1) {
		await page.keyboard.press('ArrowRight');
		await settle();
		horizontalRight.push(await record(`ArrowRight-${i + 1}`));
	}
	const horizontalLeft = [];
	await clickText('Here we present', 'start');
	for (let i = 0; i < 8; i += 1) {
		await page.keyboard.press('ArrowLeft');
		await settle();
		horizontalLeft.push(await record(`ArrowLeft-${i + 1}`));
	}

	const boundaries = [];
	for (let i = 0; i < references.length - 1; i += 1) {
		const boundary = references[i + 1].from;
		await page.evaluate((pos) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setCursor', pos } })), boundary);
		await settle();
		boundaries.push({ boundary, state: await record(`shared-boundary-${i + 1}`) });
	}

	const navigation = [];
	for (const reference of references) {
		await scrollLine();
		const button = await page.evaluate((ordinal) => window.__mlpFootnoteInteraction?.buttonRect(ordinal), reference.ordinal);
		if (!button) throw new Error(`rendered footnote button ${reference.ordinal} not found`);
		await page.mouse.click(button.x, button.y);
		await settle();
		const toDefinition = await page.evaluate(() => window.__mlpDebugSelection?.());
		const back = await page.evaluate(() => window.__mlpFootnoteInteraction?.backRect());
		if (!back) throw new Error(`footnote back button ${reference.ordinal} not found`);
		await page.mouse.click(back.x, back.y);
		await settle();
		const afterBack = await record(`mouse-footnote-${reference.ordinal}-back`);
		navigation.push({ ordinal: reference.ordinal, toDefinition, expectedDefinition: definitionHeads[reference.ordinal - 1], afterBack });
	}

	await scrollLine();
	const fixedPoint = await page.evaluate((needle) => window.__mlpFootnoteInteraction?.textRect(needle), 'spintronics');
	if (!fixedPoint) throw new Error('fixed repeated-click coordinate could not be measured');
	const fixedClick = { x: Math.max(fixedPoint.left + 1, fixedPoint.right - 2), y: fixedPoint.y };
	const repeated = [];
	for (let i = 0; i < 8; i += 1) {
		await page.mouse.click(fixedClick.x, fixedClick.y);
		await settle();
		repeated.push(await record(`repeated-click-${i + 1}`));
	}

	const allStates = [initial, afterProseClick, ...down, ...up, ...horizontalRight, ...horizontalLeft, ...boundaries.map((item) => item.state), ...navigation.map((item) => item.afterBack), ...repeated];
	const distinctY = (values) => {
		const ys = values.map((state) => state?.selection?.y).filter((value) => typeof value === 'number');
		return new Set(ys.map((value) => Math.round(value))).size >= 2;
	};
	const noSource = (values) => values.every(ordinaryState);
	const navigationOk = navigation.every((item) => item.toDefinition?.head === item.expectedDefinition && ordinaryState(item.afterBack));
	const checks = {
		proseImmediatelyBeforeCluster: ordinaryState(afterProseClick),
		arrowDownNoSource: noSource(down),
		arrowUpNoSource: noSource(up),
		arrowDownMovesVisualRows: distinctY(down),
		arrowUpMovesVisualRows: distinctY(up),
		arrowRightNoSource: noSource(horizontalRight),
		arrowLeftNoSource: noSource(horizontalLeft),
		sharedBoundariesActivateNeither: boundaries.every((item) => ordinaryState(item.state)),
		mouseNavigationPreserved: navigationOk,
		repeatedClicksStable: noSource(repeated),
		activeSourceAtMostOne: allStates.every((state) => (state?.activeSourceCount ?? 0) <= 1),
	};
	return {
		ok: Object.values(checks).every(Boolean),
		checks,
		beforeProseClick,
		boundaries,
		navigation,
		repeated,
		down: down.map((state) => state?.selection),
		up: up.map((state) => state?.selection),
		horizontalRight: horizontalRight.map((state) => state?.selection),
		horizontalLeft: horizontalLeft.map((state) => state?.selection),
		traceCount: traces.length,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	let sourcePath = null;
	if (args.source && !args.synthetic && !args.benchmark) {
		const candidate = path.resolve(REPO, args.source);
		if (!insideRepo(candidate)) throw new Error('--source must name a file inside this repository');
		try { if (!(await fs.stat(candidate)).isFile()) throw new Error(); }
		catch { throw new Error('--source must name an existing file inside this repository'); }
		sourcePath = path.relative(REPO, candidate).split(path.sep).join('/');
	}

	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	const baseUrl = `http://127.0.0.1:${port}/scripts/long-document-browser-harness.html`;
	const browser = await chromium.launch({ headless: true });
	const runs = args.benchmark ? [1000, 5000, 10000, 20000] : [null];
	const allResults = [];
	try {
		for (const benchmarkLines of runs) {
			const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
			const pageErrors = [];
			if (args.probe) page.on('console', (message) => process.stdout.write(`[browser:${message.type()}] ${message.text()}\n`));
			page.on('pageerror', (error) => pageErrors.push(String(error)));
			const started = performance.now();
			await page.goto(queryFor(baseUrl, args, benchmarkLines, sourcePath), { waitUntil: 'load' });
			await page.waitForFunction(() => window.__mlpLongDocumentResult !== undefined, null, { timeout: 30000 });
			const result = await page.evaluate(() => window.__mlpLongDocumentResult);
			result.browserElapsedMs = Number((performance.now() - started).toFixed(1));
				result.pageErrors = pageErrors;
			if (pageErrors.length) result.ok = false;
			if (args.footnoteInteraction) {
				try {
					const sourceText = await page.evaluate(() => window.__mlpTestSourceText || '');
					result.footnoteInteraction = await runFootnoteInteraction(page, sourceText);
					result.ok = result.ok && result.footnoteInteraction.ok;
				} catch (error) {
					result.ok = false;
					result.error = String(error?.stack || error);
				}
				await page.close();
				allResults.push(result);
				continue;
			}
			if (args.interaction) {
					const geometryFor = async (label) => page.evaluate((name) => {
						const target = [...document.querySelectorAll('.cm-line')].find((line) => line.textContent?.includes('TARGET-PARAGRAPH-START'));
						if (!target) throw new Error('target paragraph DOM line not found');
						const range = document.createRange();
						range.selectNodeContents(target);
						const fragments = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1).map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, center: (rect.top + rect.bottom) / 2 }));
						const rows = [];
						for (const fragment of fragments) {
							const row = rows.find((candidate) => Math.abs(candidate.center - fragment.center) <= 12);
							if (row) {
								row.left = Math.min(row.left, fragment.left);
								row.right = Math.max(row.right, fragment.right);
								row.top = Math.min(row.top, fragment.top);
								row.bottom = Math.max(row.bottom, fragment.bottom);
								row.center = (row.top + row.bottom) / 2;
							} else rows.push({ left: fragment.left, right: fragment.right, top: fragment.top, bottom: fragment.bottom, center: fragment.center });
						}
						rows.sort((a, b) => a.top - b.top);
						const text = target.textContent || '';
						const source = window.__mlpTestSourceText || '';
						const targetRect = target.getBoundingClientRect();
						return { label: name, rows: rows.map(({ left, right, top, bottom }) => ({ left, right, top, bottom, width: right - left })), targetRect: { left: targetRect.left, right: targetRect.right, top: targetRect.top, bottom: targetRect.bottom, height: targetRect.height }, targetTextLength: text.length, targetStart: source.indexOf('TARGET-PARAGRAPH-START'), followingStart: source.indexOf('FOLLOWING-PARAGRAPH-START') };
					}, label);
					const runInteraction = async (label) => {
						const geometry = await geometryFor(label);
						const probes = [];
						const rowIndexes = [...new Set([0, Math.floor(geometry.rows.length / 2), Math.max(0, geometry.rows.length - 2), geometry.rows.length - 1])];
						for (const rowIndex of rowIndexes) {
							await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setCursor', pos: 0 } })));
							await page.waitForTimeout(120);
							const freshGeometry = await geometryFor(`${label}:mouse-row-${rowIndex}`);
							const row = freshGeometry.rows[Math.min(rowIndex, freshGeometry.rows.length - 1)];
							const x = (row.left + row.right) / 2;
							const y = (row.top + row.bottom) / 2;
							await page.mouse.click(x, y);
							await page.waitForTimeout(40);
							const selection = await page.evaluate(() => window.__mlpDebugSelection?.());
							probes.push({ rowIndex, click: { x, y }, selection });
						}
						await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setCursor', pos: 0 } })));
						await page.waitForTimeout(120);
						const renderedGeometry = await geometryFor(`${label}:keyboard-rendered`);
						const first = renderedGeometry.rows[0];
						await page.mouse.click((first.left + first.right) / 2, (first.top + first.bottom) / 2);
						await page.waitForTimeout(40);
						const sourceGeometry = await geometryFor(`${label}:keyboard-source`);
						const middleSourceIndex = Math.floor(sourceGeometry.rows.length / 2);
						const middleSource = sourceGeometry.rows[middleSourceIndex];
						await page.mouse.click((middleSource.left + middleSource.right) / 2, (middleSource.top + middleSource.bottom) / 2);
						await page.waitForTimeout(40);
						const down = [];
						for (let i = 0; i < Math.max(1, Math.min(8, sourceGeometry.rows.length - middleSourceIndex - 1)); i++) {
							await page.keyboard.press('ArrowDown');
							await page.waitForTimeout(20);
							down.push(await page.evaluate(() => window.__mlpDebugSelection?.()));
						}
						const up = [];
						for (let i = 0; i < down.length; i++) {
							await page.keyboard.press('ArrowUp');
							await page.waitForTimeout(20);
							up.push(await page.evaluate(() => window.__mlpDebugSelection?.()));
						}
						return { geometry, sourceGeometry, probes, down, up };
					};
				const initialDiagnostics = await page.evaluate(() => {
					const source = window.__mlpTestSourceText || '';
					const targetStart = source.indexOf('TARGET-PARAGRAPH-START');
					const target = [...document.querySelectorAll('.cm-line')].find((line) => line.textContent?.includes('TARGET-PARAGRAPH-START'));
					const rect = target?.getBoundingClientRect();
					return { block: window.__mlpDebugLineBlock?.(targetStart), dom: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null };
				});
				const before = await runInteraction('before-theme');
			let after = null;
			if (args.theme) {
				const runtimeTheme = args.theme === 'dark.css' ? 'github-light.css' : 'dark.css';
				const css = await (await fetch(new URL(`/media/sample-styles/${runtimeTheme}`, baseUrl))).text();
				await page.evaluate((value) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'applyCss', css: value } })), css);
				await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
					after = await runInteraction(`after-theme:${runtimeTheme}`);
				}
			const paragraphs = (probe) => probe.probes.every(({ selection }) => selection && selection.head >= probe.geometry.targetStart && selection.head < probe.geometry.followingStart);
			const visualRows = (values) => values.length >= 5 && values.every((selection, index) => selection && selection.y !== null && (index === 0 || Math.abs(selection.y - values[index - 1].y) > 1));
			const reverseRows = (probe) => {
				const y = (selection) => selection?.y ?? null;
				const downFirst = y(probe.down[0]);
				const downLast = y(probe.down[probe.down.length - 1]);
				const upFirst = y(probe.up[0]);
				const upLast = y(probe.up[probe.up.length - 1]);
				return visualRows(probe.up) && downFirst !== null && downLast !== null && upFirst !== null && upLast !== null && downLast > downFirst && upFirst > upLast;
			};
			const arrowInside = (probe) => probe.down.every((selection) => selection && selection.head >= probe.geometry.targetStart && selection.head < probe.geometry.followingStart) && probe.up.every((selection) => selection && selection.head >= probe.geometry.targetStart && selection.head < probe.geometry.followingStart);
			const initialGeometryStable = initialDiagnostics.block && initialDiagnostics.dom && Math.abs(initialDiagnostics.block.height - initialDiagnostics.dom.height) <= 1;
			const interaction = { before, after, initialDiagnostics, checks: { beforeRows: before.geometry.rows.length, beforeMouseInside: paragraphs(before), beforeArrowInside: arrowInside(before), beforeArrowMoves: visualRows(before.down), beforeArrowReverses: reverseRows(before), initialGeometryStable, afterRows: after?.geometry.rows.length ?? null, afterMouseInside: after ? paragraphs(after) : null, afterArrowInside: after ? arrowInside(after) : null, afterArrowMoves: after ? visualRows(after.down) : null, afterArrowReverses: after ? reverseRows(after) : null } };
			result.interaction = interaction;
			result.ok = result.ok && before.geometry.rows.length >= 5 && interaction.checks.beforeMouseInside && interaction.checks.beforeArrowInside && interaction.checks.beforeArrowMoves && interaction.checks.beforeArrowReverses && interaction.checks.initialGeometryStable && (!after || (after.geometry.rows.length >= 5 && interaction.checks.afterMouseInside && interaction.checks.afterArrowInside && interaction.checks.afterArrowMoves && interaction.checks.afterArrowReverses));
			await page.close();
			allResults.push(result);
			continue;
			}
			allResults.push(result);
			await page.close();
		}
	} finally {
		await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}

	const printable = args.full ? (args.benchmark ? allResults : allResults[0]) : args.inlineGeometry ? allResults[0] : args.benchmark ? benchmarkResult(allResults) : compactResult(allResults[0]);
	process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
	return allResults.every((item) => item.ok) ? 0 : 1;
}

main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
