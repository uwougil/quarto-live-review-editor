import { beforeEach, describe, expect, it, vi } from 'vitest';

const changeListeners = new Set<(event: any) => void>();
const willSaveListeners = new Set<(event: any) => void>();
const didSaveListeners = new Set<(document: any) => void>();

vi.mock('vscode', () => ({
	workspace: {
		onDidChangeTextDocument: (listener: (event: any) => void) => {
			changeListeners.add(listener);
			return { dispose: () => changeListeners.delete(listener) };
		},
		onWillSaveTextDocument: (listener: (event: any) => void) => {
			willSaveListeners.add(listener);
			return { dispose: () => willSaveListeners.delete(listener) };
		},
		onDidSaveTextDocument: (listener: (document: any) => void) => {
			didSaveListeners.add(listener);
			return { dispose: () => didSaveListeners.delete(listener) };
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

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function document(initial = '') {
	let text = initial;
	const savedTexts: string[] = [];
	const doc: any = {
		uri: { toString: () => 'file:///paper.md' },
		version: 1,
		isDirty: true,
		getText: () => text,
		positionAt: (offset: number) => offset,
		apply(edit: any) {
			const changes = edit.replacements.map((replacement: any) => ({
				from: replacement.range.start,
				to: replacement.range.end,
				insert: replacement.insert,
			}));
			for (const change of changes.slice().sort((a: TextChange, b: TextChange) => b.from - a.from)) {
				text = text.slice(0, change.from) + change.insert + text.slice(change.to);
			}
			this.version++;
			return changes;
		},
		save: vi.fn(async () => {
			savedTexts.push(text);
			doc.isDirty = false;
			for (const listener of didSaveListeners) listener(doc);
			return true;
		}),
		savedTexts,
	};
	return doc;
}

function emitChanges(doc: ReturnType<typeof document>, changes: TextChange[]): void {
	for (const listener of changeListeners) listener({
		document: doc,
		contentChanges: changes.map((change) => ({
			rangeOffset: change.from,
			rangeLength: change.to - change.from,
			text: change.insert,
		})),
	});
}

function emitWillSave(doc: ReturnType<typeof document>): Promise<unknown[]> {
	const waits: Promise<unknown>[] = [];
	for (const listener of willSaveListeners) {
		listener({ document: doc, waitUntil: (promise: Thenable<unknown>) => waits.push(Promise.resolve(promise)) });
	}
	return Promise.all(waits);
}

function peer(active = true): DocumentSyncPeer & { barrierRequests: number; snapshots: string[]; acks: number[] } {
	return {
		active,
		barrierRequests: 0,
		snapshots: [],
		acks: [],
		receiveDocumentChanges() {},
		receiveSavedSnapshot(text) { this.snapshots.push(text); },
		acknowledgeEdit(editId) { this.acks.push(editId); },
		resync() {},
		async requestSaveBarrier() { this.barrierRequests++; },
		async runHistoryCommand() {},
	};
}

describe('save race ownership', () => {
	beforeEach(() => {
		changeListeners.clear();
		willSaveListeners.clear();
		didSaveListeners.clear();
		vi.clearAllMocks();
		vi.mocked(vscode.workspace.applyEdit).mockReset();
	});

	it('coalesces overlapping webview and native save barriers', async () => {
		const doc = document('abc');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const active = peer(true);
		const gate = deferred();
		active.requestSaveBarrier = () => {
			active.barrierRequests++;
			return gate.promise;
		};
		coordinator.addPeer(active);

		const webviewSave = coordinator.requestSave();
		const nativeSaveBarrier = emitWillSave(doc);
		await tick();

		expect(active.barrierRequests).toBe(1);
		gate.resolve();
		await Promise.all([webviewSave, nativeSaveBarrier]);
		expect(doc.save).toHaveBeenCalledTimes(1);
		coordinator.dispose();
	});

	it('coalesces two concurrent explicit saves into one disk write', async () => {
		const doc = document('abc');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const active = peer(true);
		const gate = deferred();
		active.requestSaveBarrier = () => {
			active.barrierRequests++;
			return gate.promise;
		};
		coordinator.addPeer(active);

		const first = coordinator.requestSave();
		const second = coordinator.requestSave();
		await tick();
		expect(active.barrierRequests).toBe(1);
		gate.resolve();
		await Promise.all([first, second]);
		expect(doc.save).toHaveBeenCalledTimes(1);
		coordinator.dispose();
	});

	it('does not let a hidden retained panel hold the active save', async () => {
		const doc = document('abc');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const active = peer(true);
		const hidden = peer(false);
		const never = deferred();
		hidden.requestSaveBarrier = () => {
			hidden.barrierRequests++;
			return never.promise;
		};
		coordinator.addPeer(active);
		coordinator.addPeer(hidden);

		await coordinator.requestSave();
		expect(active.barrierRequests).toBe(1);
		expect(hidden.barrierRequests).toBe(0);
		expect(doc.save).toHaveBeenCalledTimes(1);
		never.resolve();
		coordinator.dispose();
	});

	it('does not flush hidden pending text into another panel save', async () => {
		const doc = document('alpha\n');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const active = peer(true);
		const hidden = peer(false);
		coordinator.addPeer(active);
		coordinator.addPeer(hidden);

		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			const changes = doc.apply(edit);
			doc.isDirty = true;
			emitChanges(doc, changes);
			return true;
		});

		hidden.requestSaveBarrier = async () => {
			hidden.barrierRequests++;
			await coordinator.enqueueEdit(hidden, [{
				from: doc.getText().length,
				to: doc.getText().length,
				insert: 'stale hidden text\n',
			}], doc.version, 77);
		};

		await coordinator.requestSave();
		expect(hidden.barrierRequests).toBe(0);
		expect(doc.savedTexts).toEqual(['alpha\n']);
		expect(doc.getText()).toBe('alpha\n');
		coordinator.dispose();
	});
});
