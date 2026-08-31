// A minimal DOM stand-in for unit-testing the widget renderers.
//
// The test environment is plain Node (see vitest.config.ts) — the webview code
// under test only ever needs `document.createElement` / `createTextNode` plus
// child appending and a few attributes, so a real DOM implementation would be a
// heavyweight dependency for a very small surface. This provides exactly that
// surface, plus `serialize` for asserting on the produced markup as a string.

interface StubNode {
	nodeType: 1 | 3;
	textContent: string;
}

class StubText implements StubNode {
	readonly nodeType = 3 as const;
	constructor(public textContent: string) {}
}

class StubElement implements StubNode {
	readonly nodeType = 1 as const;
	readonly children: StubNode[] = [];
	readonly attributes = new Map<string, string>();
	readonly style: Record<string, string> = {};
	// Deliberately left out of `serialize`: the renderer's `data-mlp-*` entries
	// are bookkeeping the table editor reads back (source ranges, grid position),
	// not part of the markup these tests assert on.
	readonly dataset: Record<string, string> = {};
	className = '';
	title = '';
	src = '';
	alt = '';

	constructor(public readonly tagName: string) {}

	appendChild<T extends StubNode>(node: T): T {
		this.children.push(node);
		return node;
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	addEventListener(): void {
		/* no-op: event wiring is out of scope for these tests */
	}

	get textContent(): string {
		return this.children.map((c) => c.textContent).join('');
	}
	set textContent(value: string) {
		this.children.length = 0;
		if (value) this.children.push(new StubText(value));
	}
}

function escapeText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
	return escapeText(value).replace(/"/g, '&quot;');
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input']);

/** Serializes a stub tree to HTML, for readable assertions. */
export function serialize(node: unknown): string {
	const n = node as StubNode;
	if (n.nodeType === 3) return escapeText(n.textContent);
	const el = n as StubElement;
	let attrs = '';
	if (el.tagName === 'img') {
		if (el.src) attrs += ` src="${escapeAttr(el.src)}"`;
		attrs += ` alt="${escapeAttr(el.alt)}"`;
	}
	if (el.title) attrs += ` title="${escapeAttr(el.title)}"`;
	for (const [name, value] of el.attributes) attrs += ` ${name}="${escapeAttr(value)}"`;
	if (el.className) attrs += ` class="${escapeAttr(el.className)}"`;
	if (el.style.textAlign) attrs += ` style="text-align:${el.style.textAlign}"`;
	const inner = el.children.map(serialize).join('');
	return VOID_TAGS.has(el.tagName) ? `<${el.tagName}${attrs}>` : `<${el.tagName}${attrs}>${inner}</${el.tagName}>`;
}

/** Serializes only an element's children — the wrapper itself is often noise. */
export function serializeChildren(node: unknown): string {
	return (node as StubElement).children.map(serialize).join('');
}

/**
 * Installs the stub as the global `document` for the current test file.
 * Returns a `createElement` helper for building assertion roots.
 */
export function installStubDom(): { createElement: (tag: string) => HTMLElement } {
	const doc = {
		createElement: (tag: string) => new StubElement(tag),
		createTextNode: (text: string) => new StubText(text),
	};
	(globalThis as { document?: unknown }).document = doc;
	return { createElement: (tag: string) => doc.createElement(tag) as unknown as HTMLElement };
}
