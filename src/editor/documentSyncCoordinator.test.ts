import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Set<(event: any) => void>();
const willSaveListeners = new Set<(event: any) => void>();
const saveListeners = new Set<(document: any) => void>();

vi.mock('vscode', () => ({
	workspace: {
		onDidChangeTextDocument: (listener: (event: any) => void) => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
		onWillSaveTextDocument: (listener: (event: any) => void) => {
			willSaveListeners.add(listener);
			return { dispose: () => willSaveListeners.delete(listener) };
		},
		onDidSaveTextDocument: (listener: (document: any) => void) => {
			saveListeners.add(listener);
			return { dispose: () => saveListeners.delete(listener) };
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
		save: vi.fn(async () => true),
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

function emitChangesAtVersion(doc: ReturnType<typeof document>, changes: TextChange[], version: number): void {
	for (const listener of listeners) listener({
		document: { ...doc, version },
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

function emitSave(doc: ReturnType<typeof document>): void {
	for (const listener of saveListeners) listener(doc);
}

function emitWillSave(doc: ReturnType<typeof document>): Promise<unknown[]> {
	const waits: Promise<unknown>[] = [];
	for (const listener of willSaveListeners) {
		listener({ document: doc, waitUntil: (promise: Thenable<unknown>) => waits.push(Promise.resolve(promise)) });
	}
	return Promise.all(waits);
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

function peer(): DocumentSyncPeer & { updates: any[]; snapshots: any[]; acks: any[]; resyncs: number[]; commands: string[] } {
	return {
		updates: [], snapshots: [], acks: [], resyncs: [], commands: [],
		receiveDocumentChanges(changes, baseVersion, version) { this.updates.push({ changes, baseVersion, version }); },
		receiveSavedSnapshot(text, version) { this.snapshots.push({ text, version }); },
		acknowledgeEdit(editId, version) { this.acks.push({ editId, version }); },
		resync(editId) { this.resyncs.push(editId ?? -1); },
		async runHistoryCommand(command) { this.commands.push(command); },
	};
}

describe('DocumentSyncCoordinator', () => {
	beforeEach(() => {
		listeners.clear();
		willSaveListeners.clear();
		saveListeners.clear();
		vi.clearAllMocks();
		vi.mocked(vscode.workspace.applyEdit).mockReset();
	});

	it('serializes same-document edits without broadcasting an unsaved webview change', async () => {
		const doc = document('ab');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			applyAndEmit(doc, edit);
			return true;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		await coordinator.enqueueEdit(a, [{ from: 1, to: 1, insert: 'A' }], 1, 1);
		expect(b.updates).toEqual([]);

		// A stale queued edit is rejected with its edit id; the webview's
		// EditorSyncClient preserves it and retries against the resync snapshot.
		await coordinator.enqueueEdit(b, [{ from: 2, to: 2, insert: 'B' }], 1, 2);
		expect(b.resyncs).toEqual([2]);
		await coordinator.enqueueEdit(b, [{ from: 3, to: 3, insert: 'B' }], 2, 2);

		expect(doc.getText()).toBe('aAbB');
		expect(a.updates).toEqual([]);
		expect(a.acks).toEqual([{ editId: 1, version: 2 }]);
		expect(b.acks).toEqual([{ editId: 2, version: 3 }]);
		emitSave(doc);
		expect(a.snapshots).toEqual([{ text: 'aAbB', version: 3 }]);
		expect(b.snapshots).toEqual([{ text: 'aAbB', version: 3 }]);
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
		expect(b.updates).toEqual([]);
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
		expect(b.updates).toEqual([{ changes: external, baseVersion: 2, version: 3 }]);
		coordinator.dispose();
	});

	it('keeps a delayed local identity when an external event is observed first', async () => {
		const doc = document('ab');
		const applyResult = deferred<boolean>();
		let localChanges: TextChange[] = [];
		vi.mocked(vscode.workspace.applyEdit).mockImplementation((edit: any) => {
			localChanges = doc.apply(edit);
			return applyResult.promise;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		const operation = coordinator.enqueueEdit(a, [{ from: 1, to: 1, insert: 'A' }], 1, 13);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const external = [{ from: 3, to: 3, insert: 'X' }];
		doc.applyChanges(external);
		// The external event is dispatched before the delayed event for the local
		// mutation. Each event carries the version at which that change occurred.
		emitChangesAtVersion(doc, external, 3);
		emitChangesAtVersion(doc, localChanges, 2);
		applyResult.resolve(true);
		await operation;

		expect(a.acks).toEqual([{ editId: 13, version: 2 }]);
		expect(a.updates).toEqual([{ changes: external, baseVersion: 2, version: 3 }]);
		expect(b.updates).toEqual([{ changes: external, baseVersion: 2, version: 3 }]);
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
		expect(a.updates).toHaveLength(0);
		expect(b.updates).toHaveLength(0);
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
		expect(bText).toBe('');
		expect(a.updates).toEqual([]);
		expect(a.acks).toHaveLength(128);
		expect(b.updates).toHaveLength(0);
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

	it('converges after alternating panel edits cross the save barrier', async () => {
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
		expect(bText).toBe('');
		emitSave(doc);
		aText = 'A';
		bText = 'A';
		const bChange = [{ from: 1, to: 1, insert: 'B' }];
		bText = applyToText(bText, bChange);
		await coordinator.enqueueEdit(b, bChange, 2, 41);
		expect(aText).toBe('A');
		emitSave(doc);
		aText = 'AB';
		bText = 'AB';

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

	it('waits for a delayed local change acknowledgement before saving', async () => {
		const doc = document('ab');
		const applyResult = deferred<boolean>();
		let localChanges: TextChange[] = [];
		vi.mocked(vscode.workspace.applyEdit).mockImplementation((edit: any) => {
			localChanges = doc.apply(edit);
			return applyResult.promise;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer();
		coordinator.addPeer(a);

		const edit = coordinator.enqueueEdit(a, [{ from: 2, to: 2, insert: 'X' }], 1, 60);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const save = coordinator.requestSave();
		applyResult.resolve(true);
		await edit;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(doc.save).not.toHaveBeenCalled();

		emitChanges(doc, localChanges);
		await save;
		expect(doc.save).toHaveBeenCalledTimes(1);
		coordinator.dispose();
	});

	it('makes source-editor save participants wait for a delayed local acknowledgement', async () => {
		const doc = document('ab');
		const applyResult = deferred<boolean>();
		let localChanges: TextChange[] = [];
		vi.mocked(vscode.workspace.applyEdit).mockImplementation((edit: any) => {
			localChanges = doc.apply(edit);
			return applyResult.promise;
		});
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer();
		coordinator.addPeer(a);

		const edit = coordinator.enqueueEdit(a, [{ from: 2, to: 2, insert: 'X' }], 1, 62);
		await new Promise((resolve) => setTimeout(resolve, 0));
		let barrierSettled = false;
		const barrier = emitWillSave(doc).then(() => { barrierSettled = true; });
		applyResult.resolve(true);
		await edit;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(barrierSettled).toBe(false);

		emitChanges(doc, localChanges);
		await barrier;
		expect(barrierSettled).toBe(true);
		coordinator.dispose();
	});

	it('does not broadcast a saved snapshot when the save fails', async () => {
		const doc = document('ab');
		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			applyAndEmit(doc, edit);
			return true;
		});
		vi.mocked(doc.save).mockResolvedValue(false);
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const a = peer(); const b = peer();
		coordinator.addPeer(a); coordinator.addPeer(b);

		await coordinator.enqueueEdit(a, [{ from: 2, to: 2, insert: 'X' }], 1, 61);
		await coordinator.requestSave();
		expect(b.snapshots).toEqual([]);
		emitSave(doc);
		expect(b.snapshots).toEqual([{ text: 'abX', version: 2 }]);
		coordinator.dispose();
	});
});
