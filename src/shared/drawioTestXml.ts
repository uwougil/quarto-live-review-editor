// A dependency-free XML parser used only by the drawio unit tests.
//
// The webview has a real `DOMParser`, but the tests run under vitest's `node`
// environment (see vitest.config.ts), which does not. This parses the small,
// well-formed subset that draw.io files use into the `XmlElement` shape
// `drawio.ts` consumes — enough to drive the parser under test without adding a
// DOM implementation as a dependency.

import type { XmlElement } from './drawio';

class TestElement implements XmlElement {
	readonly childElements: TestElement[] = [];
	private readonly attrs = new Map<string, string>();
	text = '';

	constructor(public readonly tagName: string) {}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}
	get textContent(): string {
		return this.text + this.childElements.map((c) => c.textContent).join('');
	}
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeAttr(value: string): string {
	return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
		if (body.startsWith('#')) {
			const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		return ENTITIES[body.toLowerCase()] ?? m;
	});
}

/** Parses an XML string into the `XmlElement` tree `buildDiagram` expects. */
export function parseTestXml(xml: string): XmlElement {
	const stack: TestElement[] = [];
	let root: TestElement | null = null;
	// Matches a tag, or the run of text between tags.
	const tagRe = /<(\/)?([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/)?>|([^<]+)/g;

	let match: RegExpExecArray | null;
	while ((match = tagRe.exec(xml)) !== null) {
		const [, closing, name, attrText, selfClosing, textRun] = match;
		if (textRun !== undefined) {
			if (stack.length > 0) stack[stack.length - 1].text += textRun;
			continue;
		}
		if (closing) {
			stack.pop();
			continue;
		}
		const el = new TestElement(name);
		for (const attr of attrText.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
			el.setAttribute(attr[1], decodeAttr(attr[2]));
		}
		if (stack.length > 0) stack[stack.length - 1].childElements.push(el);
		else root ??= el;
		if (!selfClosing) stack.push(el);
	}

	if (!root) throw new Error('no root element in test XML');
	return root;
}
