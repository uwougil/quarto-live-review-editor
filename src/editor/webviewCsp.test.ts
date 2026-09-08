import { describe, expect, it } from 'vitest';
import { buildEditorWebviewCsp } from './webviewCsp';

describe('buildEditorWebviewCsp', () => {
	it('allows only the webview origin to load locally bundled fonts', () => {
		const csp = buildEditorWebviewCsp('vscode-webview://unit-test', 'nonce-value');
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain('font-src vscode-webview://unit-test;');
		expect(csp).not.toMatch(/font-src[^;]*https:/);
		expect(csp).toContain("script-src 'nonce-nonce-value'");
	});
});
