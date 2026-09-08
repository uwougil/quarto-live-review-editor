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
import type { TextChange } from '../shared/messages';

function document(initial = '') {
	let text = initial;
	return {
		uri: { toString: () => 'file:///paper.qmd' },
		version: 1,
		getText: () => text,
		positionAt: (offset: number) => offset,
		apply(edit: any) {
			const changes = edit.replacements.map((replacement: any) => ({
				from: replacement.range.start,
				to: replacement.range.end,
				insert: replacement.insert,
			}));
			this.applyChanges(changes);
			return changes;
		},
		applyChanges(changes: TextChange[]) {
			for (const change of changes.slice().sort((a, b) => b.from - a.from)) {
				text = text.slice(0, change.from) + change.insert + text.slice(change.to);
			}
			this.version++;
		},
	};
}

function emitChanges(doc: ReturnType<typeof document>, changes: TextChange[]): void {
	for (const listener of listeners) listener({
		document: doc,
		contentChanges: changes.map((change) => ({
			rangeOffset: change.from,
			rangeLength: change.to - change.from,
			text: change.insert,
		})),
	});
}

function applyAndEmit(doc: ReturnType<typeof document>, edit: any): void {
	const changes = doc.apply(edit);
	emitChanges(doc, changes);
}

function applyToText(text: string, changes: TextChange[]): string {
	for (const change of changes.slice().sort((a, b) => b.from - a.from)) {
		text = text.slice(0, change.from) + change.insert + text.slice(change.to);
	}
	return text;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function peer(): DocumentSyncPeer & { updates: any[]; acks: any[]; resyncs: number[]; commands: string[] } {
	return {
		updates: [], acks: [], resyncs: [], commands: [],
		receiveDocumentChanges(changes, baseVersion, version) { this.updates.push({ changes, baseVersion, version }); },
		acknowledgeEdit(editId, version) { this.acks.push({ editId, version }); },
		resync(editId) { this.resyncs.push(editId ?? -1); },
		async runHistoryCommand(command) { this.commands.push(command); },
	};
}

describe('DocumentSyncCoordinator', () => {
	beforeEach(() => {
		listeners.clear();
		vi.clearAllMocks();
		vi.mocked(vscode.workspace.applyEdit).mockReset();
	});

	it('serializes same-document edits and broadcasts each committed change to the other peer', async () => {
		const doc = document('ab');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			applyAndEmit(doc, edit);
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

	it('keeps a delayed document-change event associated with its originating edit', async () => {
		const doc = document('ab');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			const changes = doc.apply(edit);
			setTimeout(() => emitChanges(doc, changes), 0);
			return true;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		await coordinator.enqueueEdit(a, [{ from: 1, to: 1, insert: 'X' }], 1, 11);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(a.updates).toEqual([]);
		expect(a.acks).toEqual([{ editId: 11, version: 2 }]);
		expect(b.updates).toEqual([{ changes: [{ from: 1, to: 1, insert: 'X' }], baseVersion: 1, version: 2 }]);
		coordinator.dispose();
	});

	it('does not suppress an external change while applyEdit is still pending', async () => {
		const doc = document('ab');
		const applyResult = deferred<boolean>();
		vi.mocked(vscode.workspace.applyEdit).mockImplementation((edit: any) => {
			const localChanges = doc.apply(edit);
			queueMicrotask(() => emitChanges(doc, localChanges));
			return applyResult.promise;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		const operation = coordinator.enqueueEdit(a, [{ from: 1, to: 1, insert: 'A' }], 1, 12);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const external = [{ from: 3, to: 3, insert: 'X' }];
		doc.applyChanges(external);
		emitChanges(doc, external);
		applyResult.resolve(true);
		await operation;

		expect(a.acks).toEqual([{ editId: 12, version: 2 }]);
		expect(a.updates).toEqual([{ changes: external, baseVersion: 2, version: 3 }]);
		expect(b.updates).toEqual([
			{ changes: [{ from: 1, to: 1, insert: 'A' }], baseVersion: 1, version: 2 },
			{ changes: external, baseVersion: 2, version: 3 },
		]);
		coordinator.dispose();
	});

	it.each([
		['false', () => Promise.resolve(false)],
		['reject', () => Promise.reject(new Error('rejected'))],
		['throw', () => { throw new Error('thrown'); }],
	])('clears pending mutation identity when applyEdit returns %s', async (_caseName, apply) => {
		const doc = document('ab');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(apply as any);
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		const repeatedChange = [{ from: 1, to: 1, insert: 'X' }];
		await coordinator.enqueueEdit(a, repeatedChange, 1, 20);
		doc.applyChanges(repeatedChange);
		emitChanges(doc, repeatedChange);

		expect(a.resyncs).toEqual([20]);
		expect(a.updates).toHaveLength(1);
		expect(b.updates).toHaveLength(1);
		coordinator.dispose();
	});

	it('rejects a stale baseVersion without calling applyEdit', async () => {
		const doc = document('ab');
		doc.version = 4;
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer();
		coordinator.addPeer(a);

		await coordinator.enqueueEdit(a, [{ from: 2, to: 2, insert: 'X' }], 3, 30);

		expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
		expect(a.resyncs).toEqual([30]);
		coordinator.dispose();
	});

	it('serializes concurrent peers, rejects the stale edit, and accepts its retry once', async () => {
		const doc = document('ab');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			applyAndEmit(doc, edit);
			return true;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		await Promise.all([
			coordinator.enqueueEdit(a, [{ from: 2, to: 2, insert: 'A' }], 1, 31),
			coordinator.enqueueEdit(b, [{ from: 2, to: 2, insert: 'B' }], 1, 32),
		]);
		expect(b.resyncs).toEqual([32]);
		await coordinator.enqueueEdit(b, [{ from: 3, to: 3, insert: 'B' }], 2, 32);

		expect(doc.getText()).toBe('abAB');
		expect(a.acks).toEqual([{ editId: 31, version: 2 }]);
		expect(b.acks).toEqual([{ editId: 32, version: 3 }]);
		expect(a.updates).toHaveLength(1);
		expect(b.updates).toHaveLength(1);
		coordinator.dispose();
	});

	it('keeps host and both peers equal after rapid sequential typing', async () => {
		const doc = document('');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			applyAndEmit(doc, edit);
			return true;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);
		let aText = '';
		let bText = '';
		const receiveA = a.receiveDocumentChanges.bind(a);
		const receiveB = b.receiveDocumentChanges.bind(b);
		a.receiveDocumentChanges = (changes, baseVersion, version) => {
			receiveA(changes, baseVersion, version);
			aText = applyToText(aText, changes);
		};
		b.receiveDocumentChanges = (changes, baseVersion, version) => {
			receiveB(changes, baseVersion, version);
			bText = applyToText(bText, changes);
		};

		const expected = Array.from({ length: 128 }, (_, index) => index % 2 === 0 ? 'w' : 'd').join('');
		for (let index = 0; index < expected.length; index++) {
			const change = [{ from: aText.length, to: aText.length, insert: expected[index] }];
			aText = applyToText(aText, change);
			await coordinator.enqueueEdit(a, change, doc.version, index + 1);
		}

		expect(doc.getText()).toBe(expected);
		expect(aText).toBe(expected);
		expect(bText).toBe(expected);
		expect(a.updates).toEqual([]);
		expect(a.acks).toHaveLength(128);
		expect(b.updates).toHaveLength(128);
		coordinator.dispose();
	});

	it('keeps a single panel equal to the host without echoing 101 edits', async () => {
		const doc = document('');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			applyAndEmit(doc, edit);
			return true;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer();
		coordinator.addPeer(a);
		let panelText = '';

		for (let index = 0; index < 101; index++) {
			const insert = String(index % 10);
			const change = [{ from: panelText.length, to: panelText.length, insert }];
			panelText = applyToText(panelText, change);
			await coordinator.enqueueEdit(a, change, doc.version, index + 1);
		}

		expect(doc.getText()).toBe(panelText);
		expect(a.updates).toEqual([]);
		expect(a.acks).toHaveLength(101);
		coordinator.dispose();
	});

	it('converges after edits alternate between two panels', async () => {
		const doc = document('');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			applyAndEmit(doc, edit);
			return true;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);
		let aText = '';
		let bText = '';
		a.receiveDocumentChanges = (changes, baseVersion, version) => {
			a.updates.push({ changes, baseVersion, version });
			aText = applyToText(aText, changes);
		};
		b.receiveDocumentChanges = (changes, baseVersion, version) => {
			b.updates.push({ changes, baseVersion, version });
			bText = applyToText(bText, changes);
		};

		const aChange = [{ from: 0, to: 0, insert: 'A' }];
		aText = applyToText(aText, aChange);
		await coordinator.enqueueEdit(a, aChange, 1, 40);
		const bChange = [{ from: 1, to: 1, insert: 'B' }];
		bText = applyToText(bText, bChange);
		await coordinator.enqueueEdit(b, bChange, 2, 41);

		expect(doc.getText()).toBe('AB');
		expect(aText).toBe('AB');
		expect(bText).toBe('AB');
		coordinator.dispose();
	});

	it('cleans up a delayed origin when that panel closes', async () => {
		const doc = document('ab');
		let delayedChanges: TextChange[] = [];
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			delayedChanges = doc.apply(edit);
			return true;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		await coordinator.enqueueEdit(a, [{ from: 2, to: 2, insert: 'X' }], 1, 50);
		coordinator.removePeer(a);
		emitChanges(doc, delayedChanges);

		expect(a.acks).toEqual([]);
		expect(a.updates).toEqual([]);
		expect(b.updates).toHaveLength(1);
		coordinator.dispose();
	});

	it('broadcasts native undo and redo document events to every peer', async () => {
		const doc = document('abX');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);
		a.runHistoryCommand = async (command) => {
			a.commands.push(command);
			const changes = command === 'undo'
				? [{ from: 2, to: 3, insert: '' }]
				: [{ from: 2, to: 2, insert: 'X' }];
			doc.applyChanges(changes);
			emitChanges(doc, changes);
		};

		await coordinator.enqueueCommand(a, 'undo');
		await coordinator.enqueueCommand(a, 'redo');

		expect(doc.getText()).toBe('abX');
		expect(a.commands).toEqual(['undo', 'redo']);
		expect(a.updates).toHaveLength(2);
		expect(b.updates).toHaveLength(2);
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

	it('queues history commands for their originating peer', async () => {
		const doc = document('ab');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		await coordinator.enqueueCommand(a, 'undo');
		await coordinator.enqueueCommand(b, 'redo');

		expect(a.commands).toEqual(['undo']);
		expect(b.commands).toEqual(['redo']);
		coordinator.dispose();
	});
});
