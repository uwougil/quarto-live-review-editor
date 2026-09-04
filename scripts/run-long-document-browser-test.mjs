#!/usr/bin/env node

/** Run the real EditorView long-document regression in Chromium. */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
	const args = { baseline: false, synthetic: false, full: false, benchmark: false, probe: false, inlineGeometry: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--baseline') args.baseline = true;
		else if (arg === '--synthetic') args.synthetic = true;
		else if (arg === '--full') args.full = true;
		else if (arg === '--benchmark') args.benchmark = true;
		else if (arg === '--probe') args.probe = true;
		else if (arg === '--inline-geometry') args.inlineGeometry = true;
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
