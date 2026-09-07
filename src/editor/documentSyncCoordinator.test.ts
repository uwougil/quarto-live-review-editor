import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Set<(event: any) => void>();

vi.mock('vscode', () => ({
	workspace: {
		onDidChangeTextDocument: (listener: (event: any) => void) => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
		applyEdit: vi.fn(),
	},
	commands: { executeCommand: vi.fn(async () => undefined) },
	WorkspaceEdit: class {
		replacements: any[] = [];
		replace(uri: any, range: any, insert: string) { this.replacements.push({ uri, range, insert }); }
	},
	Range: class { constructor(public start: any, public end: any) {} },
}));

import * as vscode from 'vscode';
import { DocumentSyncCoordinator, type DocumentSyncPeer } from './documentSyncCoordinator';

function document(initial = '') {
	let text = initial;
	return {
		uri: { toString: () => 'file:///paper.qmd' },
		version: 1,
		getText: () => text,
		positionAt: (offset: number) => offset,
		apply(edit: any) {
			for (const replacement of edit.replacements.slice().reverse()) {
				text = text.slice(0, replacement.range.start) + replacement.insert + text.slice(replacement.range.end);
			}
			this.version++;
		},
	};
}

function peer(): DocumentSyncPeer & { updates: any[]; acks: any[]; resyncs: number[] } {
	return {
		updates: [], acks: [], resyncs: [],
		receiveDocumentChanges(changes, baseVersion, version) { this.updates.push({ changes, baseVersion, version }); },
		acknowledgeEdit(editId, version) { this.acks.push({ editId, version }); },
		resync(editId) { this.resyncs.push(editId ?? -1); },
	};
}

describe('DocumentSyncCoordinator', () => {
	beforeEach(() => { listeners.clear(); vi.clearAllMocks(); });

	it('serializes same-document edits and broadcasts each committed change to the other peer', async () => {
		const doc = document('ab');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			doc.apply(edit);
			const replacement = edit.replacements[0];
			for (const listener of listeners) listener({
				document: doc,
				contentChanges: [{ rangeOffset: replacement.range.start, rangeLength: replacement.range.end - replacement.range.start, text: replacement.insert }],
			});
			return true;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		await coordinator.enqueueEdit(a, [{ from: 1, to: 1, insert: 'A' }], 1, 1);
		expect(b.updates).toEqual([{ changes: [{ from: 1, to: 1, insert: 'A' }], baseVersion: 1, version: 2 }]);

		// A stale queued edit is rejected with its edit id; the webview's
		// EditorSyncClient preserves it and retries against the resync snapshot.
		await coordinator.enqueueEdit(b, [{ from: 2, to: 2, insert: 'B' }], 1, 2);
		expect(b.resyncs).toEqual([2]);
		await coordinator.enqueueEdit(b, [{ from: 3, to: 3, insert: 'B' }], 2, 2);

		expect(doc.getText()).toBe('aAbB');
		expect(a.updates).toEqual([{ changes: [{ from: 3, to: 3, insert: 'B' }], baseVersion: 2, version: 3 }]);
		expect(a.acks).toEqual([{ editId: 1, version: 2 }]);
		expect(b.acks).toEqual([{ editId: 2, version: 3 }]);
		coordinator.dispose();
	});

	it('broadcasts external changes to every peer and disposes the shared listener last', () => {
		const doc = document('ab');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);
		doc.version = 2;
		for (const listener of listeners) listener({
			document: doc,
			contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: 'X' }],
		});
		expect(a.updates).toHaveLength(1);
		expect(b.updates).toHaveLength(1);
		coordinator.removePeer(a);
		coordinator.dispose();
		expect(listeners.size).toBe(0);
	});
});
