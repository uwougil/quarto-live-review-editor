/** Builds the restrictive policy shared by the Live Preview editor webview. */
export function buildEditorWebviewCsp(cspSource: string, nonce: string): string {
	return [
		"default-src 'none'",
		`img-src ${cspSource} https: data:`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`font-src ${cspSource}`,
		`script-src 'nonce-${nonce}'`,
		`connect-src ${cspSource}`,
	].join('; ') + ';';
}
