import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const host = vi.hoisted(() => ({
	activeUri: 'file:///b.md',
	commands: [] as Array<{ command: string; uri: string }>,
	applyEdits: [] as unknown[],
	resolveApplyEdit: undefined as (() => void) | undefined,
	messageHandler: undefined as ((message: unknown) => void) | undefined,
	activeInput: undefined as { uri: { toString: () => string } } | undefined,
}));

vi.mock('vscode', () => ({
	TabInputCustom: class TabInputCustom {
		constructor(public readonly uri: { toString: () => string }) {}
	},
	Range: class Range {
		constructor(public readonly from: unknown, public readonly to: unknown) {}
	},
	WorkspaceEdit: class WorkspaceEdit {
		replace(...args: unknown[]) { host.applyEdits.push(args); }
	},
	commands: {
		executeCommand: vi.fn(async (command: string) => {
			host.commands.push({ command, uri: host.activeUri });
		}),
	},
	workspace: {
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		applyEdit: vi.fn(() => new Promise<boolean>((resolve) => {
			host.resolveApplyEdit = () => resolve(true);
		})),
	},
	window: {
		onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
		tabGroups: {
			get activeTabGroup() {
				return { activeTab: host.activeInput ? { input: host.activeInput } : undefined };
			},
		},
	},
}));

import { DocumentSyncSession } from './documentSync';

type TestPanel = {
	active: boolean;
	reveal: ReturnType<typeof vi.fn>;
	webview: { onDidReceiveMessage: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
};

function makeSession(uri = 'file:///a.md') {
	const document = {
		uri: { toString: () => uri },
		version: 1,
		positionAt: (offset: number) => offset,
	} as unknown as vscode.TextDocument;
	const panel = {
		active: false,
		reveal: vi.fn(function (this: { active: boolean }) {
			this.active = true;
			host.activeUri = uri;
			host.activeInput = new (vscode as never as {
				TabInputCustom: new (uri: { toString: () => string }) => { uri: { toString: () => string } };
			}).TabInputCustom({ toString: () => uri });
		}),
		webview: {
			onDidReceiveMessage: vi.fn((handler: (message: unknown) => void) => {
				host.messageHandler = handler;
				return { dispose: vi.fn() };
			}),
			postMessage: vi.fn(),
		},
	} as unknown as TestPanel;
	const session = new DocumentSyncSession(document, panel as unknown as vscode.WebviewPanel, () => '');
	return { panel, session };
}

async function waitForQueue(session: DocumentSyncSession): Promise<void> {
	await (session as unknown as { editQueue: Promise<void> }).editQueue;
}

describe('DocumentSyncSession native history commands', () => {
	beforeEach(() => {
		host.activeUri = 'file:///b.md';
		host.commands = [];
		host.applyEdits = [];
		host.resolveApplyEdit = undefined;
		host.messageHandler = undefined;
		host.activeInput = undefined;
	});

	it.each(['undo', 'redo'] as const)('restores the originating panel before queued %s', async (command) => {
		const { panel, session } = makeSession();

		host.messageHandler?.({ type: command });
		await waitForQueue(session);

		expect(panel.reveal).toHaveBeenCalledWith(undefined, false);
		expect(host.commands).toEqual([{ command, uri: 'file:///a.md' }]);
	});

	it('refuses the command when the active tab is no longer the target document', async () => {
		const { panel, session } = makeSession();
		panel.active = true;
		host.activeInput = { uri: { toString: () => 'file:///b.md' } };

		host.messageHandler?.({ type: 'undo' });
		await waitForQueue(session);

		expect(host.commands).toEqual([]);
	});

	it('waits for pending edits to apply before undoing', async () => {
		const { session } = makeSession();

		host.messageHandler?.({ type: 'edit', baseVersion: 1, editId: 1, changes: [{ from: 0, to: 0, insert: 'x' }] });
		host.messageHandler?.({ type: 'undo' });
		await Promise.resolve();
		await Promise.resolve();
		expect(host.commands).toEqual([]);
		expect(host.applyEdits).toHaveLength(1);

		host.resolveApplyEdit?.();
		await waitForQueue(session);
		expect(host.commands).toEqual([{ command: 'undo', uri: 'file:///a.md' }]);
	});

	it('keeps consecutive undo and redo commands in queue order', async () => {
		const { session } = makeSession();

		host.messageHandler?.({ type: 'undo' });
		host.messageHandler?.({ type: 'redo' });
		await waitForQueue(session);

		expect(host.commands).toEqual([
			{ command: 'undo', uri: 'file:///a.md' },
			{ command: 'redo', uri: 'file:///a.md' },
		]);
	});
});
