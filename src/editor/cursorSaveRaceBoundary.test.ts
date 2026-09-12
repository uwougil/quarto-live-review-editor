import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';

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
import { EditorSyncClient } from '../webview-editor/syncClient';
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

function peer(): DocumentSyncPeer & { acks: number[]; resyncs: number[]; snapshots: string[] } {
	return {
		acks: [], resyncs: [], snapshots: [],
		receiveDocumentChanges() {},
		receiveSavedSnapshot(text) { this.snapshots.push(text); },
		acknowledgeEdit(editId) { this.acks.push(editId); },
		resync(editId) { this.resyncs.push(editId ?? -1); },
		requestSaveBarrier: async () => undefined,
		runHistoryCommand: async () => undefined,
	};
}

function applyView(text: string, changes: ChangeSet): string {
	return changes.apply(Text.of(text.split('\n'))).toString();
}

describe('Cursor-like save race boundaries', () => {
	beforeEach(() => {
		changeListeners.clear();
		willSaveListeners.clear();
		didSaveListeners.clear();
		vi.clearAllMocks();
		vi.mocked(vscode.workspace.applyEdit).mockReset();
	});

	it('runs two independent save barriers when webview Mod-S and host save overlap', async () => {
		const doc = document('abc');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const p = peer();
		const barriers = [deferred(), deferred()];
		let barrierRequests = 0;
		p.requestSaveBarrier = () => barriers[barrierRequests++].promise;
		coordinator.addPeer(p);

		// This models one physical Ctrl+S reaching both CodeMirror's Mod-S handler
		// and the outer Cursor/VS Code workbench save command.
		const webviewSave = coordinator.requestSave();
		const hostSaveParticipant = emitWillSave(doc);
		await tick();

		expect(barrierRequests).toBe(2);
		expect(doc.save).not.toHaveBeenCalled();

		// The first lifecycle can proceed independently while the second still
		// waits, proving that this is not a coalesced/deduplicated save operation.
		barriers[0].resolve();
		await tick();
		expect(doc.save).toHaveBeenCalledTimes(1);

		let hostSettled = false;
		void hostSaveParticipant.then(() => { hostSettled = true; });
		await tick();
		expect(hostSettled).toBe(false);

		barriers[1].resolve();
		await Promise.all([webviewSave, hostSaveParticipant]);
		expect(hostSettled).toBe(true);
		coordinator.dispose();
	});

	it('lets a hidden peer hold the entire save behind its barrier acknowledgement', async () => {
		const doc = document('abc');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const active = peer();
		const hidden = peer();
		const hiddenGate = deferred();
		active.requestSaveBarrier = async () => undefined;
		hidden.requestSaveBarrier = () => hiddenGate.promise;
		coordinator.addPeer(active);
		coordinator.addPeer(hidden);

		let settled = false;
		const save = coordinator.requestSave().then(() => { settled = true; });
		await tick();
		expect(settled).toBe(false);
		expect(doc.save).not.toHaveBeenCalled();

		hiddenGate.resolve();
		await save;
		expect(doc.save).toHaveBeenCalledTimes(1);
		coordinator.dispose();
	});

	it('allows a hidden peer to change canonical text during another panel save barrier', async () => {
		const doc = document('alpha\n');
		const coordinator = new DocumentSyncCoordinator(doc as any);
		const active = peer();
		const hidden = peer();
		coordinator.addPeer(active);
		coordinator.addPeer(hidden);

		vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
			const changes = doc.apply(edit);
			emitChanges(doc, changes);
			return true;
		});

		active.requestSaveBarrier = async () => undefined;
		hidden.requestSaveBarrier = async () => {
			// This is the state after a stale hidden panel has reconciled/rebased its
			// pending local edit: the save barrier explicitly flushes it before disk IO.
			await coordinator.enqueueEdit(hidden, [{
				from: doc.getText().length,
				to: doc.getText().length,
				insert: 'beta\n',
			}], doc.version, 77);
		};

		await coordinator.requestSave();
		expect(doc.savedTexts).toEqual(['alpha\nbeta\n']);
		expect(hidden.acks).toEqual([77]);
		coordinator.dispose();
	});

	it('does not roll back pending local text from duplicate same-version saved snapshots alone', () => {
		const client = new EditorSyncClient('abc', 1);
		client.recordLocal(ChangeSet.of({ from: 3, insert: 'X' }, 3));
		let viewText = 'abcX';

		const first = client.receiveSavedSnapshot({ text: 'abc', version: 1 });
		viewText = applyView(viewText, first.viewChanges);
		const second = client.receiveSavedSnapshot({ text: 'abc', version: 1 });
		viewText = applyView(viewText, second.viewChanges);

		expect(viewText).toBe('abcX');
		expect(client.hasOutstandingEdits).toBe(true);
	});
});

describe('Git tracking boundary', () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it('Git tracking/status/diff does not rewrite a Markdown working-tree file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'qlre-git-boundary-'));
		tempDirs.push(dir);
		const file = join(dir, 'paper.md');
		writeFileSync(file, 'saved v1\n');
		writeFileSync(join(dir, '.gitattributes'), '* text=auto\n');

		const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
		expect(git('init').status).toBe(0);
		expect(git('config', 'user.email', 'ci@example.invalid').status).toBe(0);
		expect(git('config', 'user.name', 'CI').status).toBe(0);
		expect(git('add', '.').status).toBe(0);
		expect(git('commit', '-m', 'fixture').status).toBe(0);

		writeFileSync(file, 'edited in live preview\r\n');
		expect(git('status', '--porcelain').status).toBe(0);
		expect(git('diff', '--', 'paper.md').status).toBe(0);

		// Git may normalize text in the index/commit representation, but merely
		// tracking the file or asking for SCM status/diff does not rewrite the
		// working-tree bytes that the editor just saved.
		expect(readFileSync(file, 'utf8')).toBe('edited in live preview\r\n');
	});
});
