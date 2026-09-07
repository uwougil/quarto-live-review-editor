import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
	messageHandler: undefined as ((message: unknown) => void) | undefined,
	documentChangeHandler: undefined as ((event: unknown) => void) | undefined,
	posts: [] as unknown[],
	writes: [] as string[],
	deletes: [] as string[],
	applyEditResult: true,
}));

vi.mock('vscode', () => {
	class Uri {
		readonly scheme = 'file';
		readonly authority = '';
		constructor(readonly path: string) {}
		get fsPath() { return this.path; }
		toString() { return `file://${this.path}`; }
		static joinPath(base: Uri, ...parts: string[]) { return new Uri([base.path, ...parts].join('/')); }
		static parse(value: string) { return new Uri(value); }
		static file(value: string) { return new Uri(value); }
	}
	class WorkspaceEdit {
		readonly inserts: unknown[] = [];
		insert(uri: Uri, position: unknown, text: string) { this.inserts.push({ uri, position, text }); }
	}
	const disposable = () => ({ dispose() {} });
	return {
		Uri,
		WorkspaceEdit,
		Position: class Position { constructor(readonly line: number, readonly character: number) {} },
		Range: class Range { constructor(readonly start: unknown, readonly end: unknown) {} },
		Selection: class Selection { constructor(readonly anchor: unknown, readonly active: unknown) {} },
		TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
		ColorThemeKind: { Light: 1, HighContrastLight: 4 },
		workspace: {
			getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
			onDidChangeTextDocument: (handler: (event: unknown) => void) => {
				mockState.documentChangeHandler = handler;
				return disposable();
			},
			openTextDocument: vi.fn(),
			applyEdit: async () => mockState.applyEditResult,
			fs: {
				createDirectory: async () => undefined,
				readDirectory: async () => [],
				writeFile: async (uri: Uri) => { mockState.writes.push(uri.toString()); },
				delete: async (uri: Uri) => { mockState.deletes.push(uri.toString()); },
				stat: async () => ({}),
				readFile: async () => new Uint8Array(),
			},
		},
		window: {
			activeColorTheme: { kind: 1 },
			onDidChangeActiveColorTheme: () => disposable(),
			showWarningMessage: vi.fn(),
			visibleTextEditors: [],
		},
		commands: { executeCommand: vi.fn() },
		env: { openExternal: vi.fn() },
	};
});

import * as vscode from 'vscode';
import { DocumentSyncSession } from './documentSync';

function createSession(version = 1, text = 'abc') {
	const document = {
		uri: vscode.Uri.file('/notes/example.qmd'),
		version,
		getText: () => text,
		positionAt: (offset: number) => ({ offset }),
	} as unknown as vscode.TextDocument;
	const panel = {
		active: true,
		webview: {
			onDidReceiveMessage: (handler: (message: unknown) => void) => {
				mockState.messageHandler = handler;
				return { dispose() {} };
			},
			postMessage: (message: unknown) => {
				mockState.posts.push(message);
				return Promise.resolve(true);
			},
			asWebviewUri: (uri: vscode.Uri) => uri,
		},
	} as unknown as vscode.WebviewPanel;
	return new DocumentSyncSession(document, panel, () => '');
}

async function send(session: DocumentSyncSession, message: unknown): Promise<void> {
	mockState.messageHandler?.(message);
	await (session as unknown as { editQueue: Promise<void> }).editQueue;
}

beforeEach(() => {
	mockState.messageHandler = undefined;
	mockState.documentChangeHandler = undefined;
	mockState.posts.length = 0;
	mockState.writes.length = 0;
	mockState.deletes.length = 0;
	mockState.applyEditResult = true;
});

describe('DocumentSyncSession image operation boundary', () => {
	it('rejects a stale image position before writing an asset', async () => {
		const session = createSession(2);
		await send(session, { type: 'pasteImage', requestId: 7, baseVersion: 1, atPos: 1, mimeType: 'image/png', dataBase64: 'AA==', needsOwnParagraph: false });
		expect(mockState.writes).toEqual([]);
		expect(mockState.posts).toContainEqual(expect.objectContaining({ type: 'resync', version: 2 }));
		expect(mockState.posts).toContainEqual({ type: 'imageResult', requestId: 7, ok: false, error: '文档已变化，请重试图片插入。' });
		session.dispose();
	});

	it('deletes exactly the newly written asset when the document edit fails', async () => {
		mockState.applyEditResult = false;
		const session = createSession();
		await send(session, { type: 'pasteImage', requestId: 8, baseVersion: 1, atPos: 2, mimeType: 'image/png', dataBase64: 'AA==', needsOwnParagraph: false });
		expect(mockState.writes).toHaveLength(1);
		expect(mockState.deletes).toEqual(mockState.writes);
		expect(mockState.posts).toContainEqual(expect.objectContaining({ type: 'imageResult', requestId: 8, ok: false }));
		session.dispose();
	});

	it('acknowledges a successful image operation without deleting its asset', async () => {
		const session = createSession();
		await send(session, { type: 'pasteImage', requestId: 9, baseVersion: 1, atPos: 2, mimeType: 'image/png', dataBase64: 'AA==', needsOwnParagraph: false });
		expect(mockState.writes).toHaveLength(1);
		expect(mockState.deletes).toEqual([]);
		expect(mockState.posts).toContainEqual({ type: 'imageResult', requestId: 9, ok: true });
		const cursor = mockState.posts.find((message) => (message as { type?: string }).type === 'setCursor') as { pos: number };
		expect(cursor.pos).toBeGreaterThan(2);
		session.dispose();
	});
});
