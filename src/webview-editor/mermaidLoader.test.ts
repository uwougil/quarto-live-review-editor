import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * These cover the on-demand Mermaid chunk loader. Its failure mode is silent —
 * a missing nonce, a double-inserted <script>, or a poisoned cache all end with
 * diagrams simply never appearing — so each branch is asserted explicitly.
 *
 * The suite runs under vitest's `node` environment (see vitest.config.ts), so a
 * minimal `document`/`window` stand-in is installed per test rather than
 * pulling in a full DOM implementation for these few assertions.
 */

interface FakeScript {
	src: string;
	nonce?: string;
	listeners: Record<string, Array<() => void>>;
	addEventListener(type: string, fn: () => void): void;
	dispatch(type: string): void;
}

function createFakeScript(): FakeScript {
	return {
		src: '',
		listeners: {},
		addEventListener(type, fn) {
			(this.listeners[type] ??= []).push(fn);
		},
		dispatch(type) {
			for (const fn of this.listeners[type] ?? []) fn();
		},
	};
}

let appended: FakeScript[] = [];

/** Installs the DOM/global surface `mermaidLoader` touches, then re-imports it
 * fresh so its module-level promise cache starts empty for every test. */
async function freshLoader() {
	appended = [];
	const globals = globalThis as Record<string, unknown>;
	globals.document = {
		createElement: () => createFakeScript(),
		head: { appendChild: (s: FakeScript) => appended.push(s) },
	};
	globals.window = {};
	vi.resetModules();
	return import('./mermaidLoader');
}

describe('loadMermaidModule', () => {
	beforeEach(async () => {
		await freshLoader();
	});

	afterEach(() => {
		const globals = globalThis as Record<string, unknown>;
		delete globals.document;
		delete globals.window;
	});

	it('resolves immediately when the chunk is already on window', async () => {
		const { loadMermaidModule } = await freshLoader();
		const stub = { render: vi.fn() };
		(globalThis as any).window.mlpMermaid = stub;

		await expect(loadMermaidModule()).resolves.toBe(stub);
		// No <script> should be inserted for an already-loaded chunk.
		expect(appended).toHaveLength(0);
	});

	it('injects a nonce-stamped script and resolves once it registers itself', async () => {
		const { loadMermaidModule } = await freshLoader();
		const win = (globalThis as any).window;
		win.mlpMermaidChunkUri = 'vscode-webview://host/dist/mermaid-chunk.js';
		win.mlpNonce = 'abc123';

		const promise = loadMermaidModule();
		expect(appended).toHaveLength(1);
		expect(appended[0].src).toBe('vscode-webview://host/dist/mermaid-chunk.js');
		// The webview CSP is `script-src 'nonce-...'`: an un-stamped tag is blocked.
		expect(appended[0].nonce).toBe('abc123');

		const stub = { render: vi.fn() };
		win.mlpMermaid = stub;
		appended[0].dispatch('load');

		await expect(promise).resolves.toBe(stub);
	});

	it('inserts only one script when several diagrams load concurrently', async () => {
		const { loadMermaidModule } = await freshLoader();
		const win = (globalThis as any).window;
		win.mlpMermaidChunkUri = 'chunk.js';

		const first = loadMermaidModule();
		const second = loadMermaidModule();
		expect(appended).toHaveLength(1);

		const stub = { render: vi.fn() };
		win.mlpMermaid = stub;
		appended[0].dispatch('load');

		await expect(first).resolves.toBe(stub);
		await expect(second).resolves.toBe(stub);
	});

	it('rejects when the host never supplied a chunk URI', async () => {
		const { loadMermaidModule } = await freshLoader();
		await expect(loadMermaidModule()).rejects.toThrow(/chunk URI/);
		expect(appended).toHaveLength(0);
	});

	it('rejects when the script loads but registers nothing', async () => {
		const { loadMermaidModule } = await freshLoader();
		(globalThis as any).window.mlpMermaidChunkUri = 'chunk.js';

		const promise = loadMermaidModule();
		appended[0].dispatch('load'); // fired without setting window.mlpMermaid
		await expect(promise).rejects.toThrow(/did not register/);
	});

	it('rejects on a network error and lets a later call retry', async () => {
		const { loadMermaidModule } = await freshLoader();
		const win = (globalThis as any).window;
		win.mlpMermaidChunkUri = 'chunk.js';

		const failing = loadMermaidModule();
		appended[0].dispatch('error');
		await expect(failing).rejects.toThrow(/Failed to load/);

		// A rejected load must not be cached, or every later diagram in the
		// document inherits the failure and silently never renders.
		const retry = loadMermaidModule();
		expect(appended).toHaveLength(2);

		const stub = { render: vi.fn() };
		win.mlpMermaid = stub;
		appended[1].dispatch('load');
		await expect(retry).resolves.toBe(stub);
	});
});
