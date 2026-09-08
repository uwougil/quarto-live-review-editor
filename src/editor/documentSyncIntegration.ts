import * as vscode from 'vscode';
import { ChangeSet, Text } from '@codemirror/state';
import type { TextChange } from '../shared/messages';
import type { DocumentSyncPeer } from './documentSyncCoordinator';
import { DocumentSyncCoordinator } from './documentSyncCoordinator';
import { EditorSyncClient } from '../webview-editor/syncClient';

interface SyncIntegrationReport {
	initialText: string;
	finalText: string;
	dirtyAfterEdit: boolean;
	siblingUnchangedBeforeSave: boolean;
	savedSnapshotCount: number;
	externalUpdateCount: number;
	saveFailureBroadcastCount: number;
	staleScenarioCount: number;
	staleResyncCount: number;
	staleRetryCount: number;
	staleSaveFailureBroadcastCount: number;
	staleFinalText: string;
}

function ensure(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Document sync integration failed: ${message}`);
}

function applyChange(text: string, change: TextChange): string {
	return text.slice(0, change.from) + change.insert + text.slice(change.to);
}

function applyViewChanges(text: string, changes: ChangeSet): string {
	return changes.apply(Text.of(text.split('\n'))).toString();
}

class ProbePeer implements DocumentSyncPeer {
	readonly savedSnapshots: Array<{ text: string; version: number }> = [];
	readonly externalUpdates: Array<{ baseVersion: number; version: number }> = [];
	readonly acknowledgements: number[] = [];

	constructor(public text: string, public version: number) {}

	receiveDocumentChanges(changes: TextChange[], baseVersion: number, version: number): void {
		ensure(baseVersion === this.version, `external update base ${baseVersion} did not match peer version ${this.version}`);
		for (const change of changes.slice().sort((a, b) => b.from - a.from)) this.text = applyChange(this.text, change);
		this.version = version;
		this.externalUpdates.push({ baseVersion, version });
	}

	receiveSavedSnapshot(text: string, version: number): void {
		this.text = text;
		this.version = version;
		this.savedSnapshots.push({ text, version });
	}

	acknowledgeEdit(editId: number, version: number): void {
		this.version = version;
		this.acknowledgements.push(editId);
	}

	resync(): void {
		throw new Error('The integration scenario did not expect a resync.');
	}

	async runHistoryCommand(): Promise<void> {
		throw new Error('The integration scenario did not expect a history command.');
	}

	applyLocal(change: TextChange): void {
		this.text = applyChange(this.text, change);
	}
}

/**
 * A webview-side peer for the real Extension Host integration. It uses the
 * production EditorSyncClient state machine and only models the asynchronous
 * message hop between a webview and the host.
 */
class EditorSyncIntegrationPeer implements DocumentSyncPeer {
	readonly client: EditorSyncClient;
	readonly resyncs: number[] = [];
	readonly retriedEditIds: number[] = [];
	readonly savedSnapshots: Array<{ text: string; version: number }> = [];
	readonly resyncedTexts: string[] = [];
	private viewText: string;
	private readonly operations = new Set<Promise<void>>();
	private retryPending = false;

	constructor(
		text: string,
		version: number,
		private readonly coordinator: DocumentSyncCoordinator,
		private readonly document: vscode.TextDocument,
	) {
		this.client = new EditorSyncClient(text, version);
		this.viewText = text;
	}

	get text(): string { return this.viewText; }

	localEdit(change: TextChange): void {
		const previousText = this.viewText;
		this.viewText = applyChange(previousText, change);
		this.client.recordLocal(ChangeSet.of({ from: change.from, to: change.to, insert: change.insert }, previousText.length));
		this.drainOutbound();
	}

	requestSave(): void {
		this.client.requestSave();
		this.drainOutbound();
	}

	async waitForIdle(): Promise<void> {
		for (;;) {
			const operations = [...this.operations];
			if (operations.length > 0) {
				await Promise.all(operations);
				continue;
			}
			if (!this.client.hasOutstandingEdits && !this.client.hasPendingSave) return;
			await tick();
		}
	}

	receiveDocumentChanges(changes: TextChange[], baseVersion: number, version: number): void {
		const transition = this.client.receiveExternal({ changes, baseVersion, version });
		if (transition.resyncRequired) {
			this.scheduleResync();
			return;
		}
		this.viewText = applyViewChanges(this.viewText, transition.viewChanges);
		this.drainOutbound();
	}

	receiveSavedSnapshot(text: string, version: number): void {
		const transition = this.client.receiveSavedSnapshot({ text, version });
		this.viewText = applyViewChanges(this.viewText, transition.viewChanges);
		this.savedSnapshots.push({ text, version });
		this.drainOutbound();
	}

	acknowledgeEdit(editId: number, version: number): void {
		if (this.client.acknowledge(editId, version).resyncRequired) {
			this.scheduleResync();
			return;
		}
		this.drainOutbound();
	}

	resync(rejectedEditId?: number): void {
		this.resyncs.push(rejectedEditId ?? -1);
		this.retryPending = true;
		this.schedule(() => {
			const transition = this.client.receiveResync({
				text: this.document.getText(),
				version: this.document.version,
				rejectedEditId,
			});
			this.viewText = applyViewChanges(this.viewText, transition.viewChanges);
			this.resyncedTexts.push(this.viewText);
			this.drainOutbound();
			return Promise.resolve();
		});
	}

	async runHistoryCommand(): Promise<void> {
		throw new Error('The stale-sibling integration scenario did not expect a history command.');
	}

	private scheduleResync(): void {
		this.resync();
	}

	private drainOutbound(): void {
		const edit = this.client.takeNextEdit();
		if (edit) {
			if (this.retryPending) {
				this.retriedEditIds.push(edit.editId);
				this.retryPending = false;
			}
			this.schedule(() => this.coordinator.enqueueEdit(this, edit.changes, edit.baseVersion, edit.editId));
			return;
		}
		if (this.client.hasOutstandingEdits) return;
		if (this.client.takeSaveRequest()) {
			this.schedule(() => this.coordinator.requestSave());
		}
	}

	private schedule(operation: () => Promise<void>): void {
		const task = new Promise<void>((resolve, reject) => {
			setImmediate(() => {
				Promise.resolve().then(operation).then(resolve, reject);
			});
		});
		this.operations.add(task);
		void task.then(
			() => this.operations.delete(task),
			() => this.operations.delete(task),
		);
	}
}

class IntegrationFileSystemProvider implements vscode.FileSystemProvider {
	private content = new Uint8Array();
	failWrites = false;

	private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changes.event;

	watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

	stat(): vscode.FileStat {
		return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: this.content.byteLength };
	}

	readFile(): Uint8Array { return this.content.slice(); }

	writeFile(uri: vscode.Uri, content: Uint8Array): void {
		if (this.failWrites) throw vscode.FileSystemError.NoPermissions(uri);
		this.content = content.slice();
	}

	delete(): void { this.content = new Uint8Array(); }
	rename(): void { /* the integration document is never renamed */ }
	copy(): void { /* the integration document is never copied */ }
	createDirectory(): void { /* the integration document has no directories */ }
	readDirectory(): [string, vscode.FileType][] { return []; }
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface StaleSiblingIntegrationReport {
	scenarioCount: number;
	resyncCount: number;
	retryCount: number;
	saveFailureBroadcastCount: number;
	finalText: string;
}

async function applyWorkspaceChange(document: vscode.TextDocument, change: TextChange): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(document.positionAt(change.from), document.positionAt(change.to)), change.insert);
	ensure(await vscode.workspace.applyEdit(edit), 'VS Code rejected a workspace edit');
	await tick();
}

async function runStaleSiblingIntegration(
	document: vscode.TextDocument,
	coordinator: DocumentSyncCoordinator,
	provider: IntegrationFileSystemProvider,
): Promise<StaleSiblingIntegrationReport> {
	let expected = document.getText();
	const a = new EditorSyncIntegrationPeer(expected, document.version, coordinator, document);
	const b = new EditorSyncIntegrationPeer(expected, document.version, coordinator, document);
	coordinator.addPeer(a);
	coordinator.addPeer(b);

	const ensureConverged = (label: string, expectedText: string): void => {
		ensure(document.getText() === expectedText, `${label}: host text diverged from expected text`);
		ensure(a.text === expectedText, `${label}: panel A diverged from expected text`);
		ensure(b.text === expectedText, `${label}: panel B diverged from expected text`);
		ensure(!document.isDirty, `${label}: successful save left the document dirty`);
	};

	// Scenario A: B edits from the saved snapshot after A has an unsaved host edit.
	const scenarioAStart = expected;
	a.localEdit({ from: a.text.length, to: a.text.length, insert: 'A' });
	await a.waitForIdle();
	ensure(document.isDirty, 'scenario A: A edit did not dirty the native document');
	ensure(b.text === scenarioAStart, 'scenario A: B did not retain its stale saved snapshot');
	b.localEdit({ from: b.text.length, to: b.text.length, insert: 'B' });
	b.requestSave();
	await Promise.all([a.waitForIdle(), b.waitForIdle()]);
	expected += 'AB';
	ensureConverged('scenario A', expected);

	// Scenario B: A has recent activity when B starts from its stale snapshot.
	const scenarioBStart = expected;
	a.localEdit({ from: a.text.length, to: a.text.length, insert: '1' });
	await a.waitForIdle();
	a.localEdit({ from: a.text.length, to: a.text.length, insert: '2' });
	ensure(b.text === scenarioBStart, 'scenario B: B changed before it started its stale edit');
	b.localEdit({ from: b.text.length, to: b.text.length, insert: 'x' });
	b.requestSave();
	await Promise.all([a.waitForIdle(), b.waitForIdle()]);
	expected += '12x';
	ensureConverged('scenario B', expected);

	// Scenario C: rapid typing on both sides crosses the stale-base rejection.
	const scenarioCStart = expected;
	for (const character of '345') a.localEdit({ from: a.text.length, to: a.text.length, insert: character });
	for (const character of 'uvw') b.localEdit({ from: b.text.length, to: b.text.length, insert: character });
	b.requestSave();
	await Promise.all([a.waitForIdle(), b.waitForIdle()]);
	expected += '345uvw';
	ensureConverged('scenario C', expected);
	ensure(b.text.startsWith(scenarioCStart), 'scenario C: rapid stale typing overwrote the saved prefix');

	// Scenario D: inspect the actual resync result before the retry is acknowledged.
	const resyncTextCount = b.resyncedTexts.length;
	const scenarioDStart = expected;
	a.localEdit({ from: a.text.length, to: a.text.length, insert: 'R' });
	b.localEdit({ from: b.text.length, to: b.text.length, insert: 'r' });
	b.requestSave();
	await Promise.all([a.waitForIdle(), b.waitForIdle()]);
	expected += 'Rr';
	ensureConverged('scenario D', expected);
	ensure(b.resyncedTexts.length > resyncTextCount, 'scenario D: stale B edit never passed through resync');
	ensure(b.resyncedTexts.at(-1)?.endsWith('Rr'), 'scenario D: B local edit was lost during resync/rebase');
	ensure(b.text.startsWith(scenarioDStart), 'scenario D: rebase overwrote the prior canonical prefix');

	// Scenario E: the reconciled stale edit remains local/host-authoritative when
	// saving fails, and no successful-save snapshot is emitted.
	const snapshotsBeforeFailure = b.savedSnapshots.length;
	a.localEdit({ from: a.text.length, to: a.text.length, insert: 'E' });
	b.localEdit({ from: b.text.length, to: b.text.length, insert: 'F' });
	b.requestSave();
	provider.failWrites = true;
	await Promise.all([a.waitForIdle(), b.waitForIdle()]);
	expected += 'EF';
	ensure(document.isDirty, 'scenario E: failed save unexpectedly cleaned the document');
	ensure(document.getText() === expected, 'scenario E: failed-save host text lost reconciled edits');
	ensure(b.text === expected, 'scenario E: failed-save origin lost its reconciled local edit');
	ensure(b.savedSnapshots.length === snapshotsBeforeFailure, 'scenario E: failed save broadcast a saved snapshot');
	const saveFailureBroadcastCount = b.savedSnapshots.length - snapshotsBeforeFailure;

	provider.failWrites = false;
	b.requestSave();
	await Promise.all([a.waitForIdle(), b.waitForIdle()]);
	ensureConverged('scenario E cleanup', expected);

	return {
		scenarioCount: 5,
		resyncCount: b.resyncs.length,
		retryCount: b.retriedEditIds.length,
		saveFailureBroadcastCount,
		finalText: expected,
	};
}

/**
 * Runs the host-side synchronization contract against the real VS Code
 * extension host. It intentionally uses probes instead of webview mocks so
 * WorkspaceEdit, TextDocument versions, dirty state, save participants and
 * save events all come from VS Code itself.
 */
export async function runDocumentSyncIntegration(): Promise<SyncIntegrationReport> {
	const provider = new IntegrationFileSystemProvider();
	const scheme = `mlp-sync-${process.pid}`;
	const uri = vscode.Uri.parse(`${scheme}:/document.md`);
	const providerRegistration = vscode.workspace.registerFileSystemProvider(scheme, provider, { isCaseSensitive: true });
	let document: vscode.TextDocument | undefined;
	let coordinator: DocumentSyncCoordinator | undefined;

	try {
		const initialText = 'seed';
		await vscode.workspace.fs.writeFile(uri, Buffer.from(initialText, 'utf8'));
		document = await vscode.workspace.openTextDocument(uri);
		ensure(await document.save(), 'could not establish the clean initial document');

		coordinator = new DocumentSyncCoordinator(document);
		const a = new ProbePeer(initialText, document.version);
		const b = new ProbePeer(initialText, document.version);
		coordinator.addPeer(a);
		coordinator.addPeer(b);

		// Rapid local typing is submitted without a debounce. The second and later
		// messages are queued behind the first host acknowledgement.
		const rapidText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
		const rapidOperations: Promise<void>[] = [];
		for (const character of rapidText) {
			const change = { from: a.text.length, to: a.text.length, insert: character };
			a.applyLocal(change);
			rapidOperations.push(coordinator.enqueueEdit(a, [change], document.version + rapidOperations.length, rapidOperations.length + 1));
		}
		await rapidOperations[0];
		const dirtyAfterEdit = document.isDirty;
		ensure(dirtyAfterEdit, 'the native dirty state did not appear after local input');
		const siblingBeforeSave = b.text;
		await Promise.all(rapidOperations);
		const siblingUnchangedBeforeSave = b.text === siblingBeforeSave;
		ensure(siblingUnchangedBeforeSave, 'sibling changed before the save barrier');
		await coordinator.requestSave();
		await tick();
		ensure(!document.isDirty, 'successful save left the document dirty');
		ensure(a.text === document.getText() && b.text === document.getText(), 'saved snapshot did not converge all peers');

		const stale = await runStaleSiblingIntegration(document, coordinator, provider);

		// Save immediately after the final local character is sent through the same
		// coordinator queue used by the webview's Mod-S handler. This closes the
		// window where a direct TextDocument.save() could observe a still-clean host
		// document before its queued edit message has been applied.
		const immediateChange = { from: a.text.length, to: a.text.length, insert: '!' };
		a.applyLocal(immediateChange);
		const immediateEdit = coordinator.enqueueEdit(a, [immediateChange], document.version, 1000);
		const immediateSave = coordinator.requestSave();
		await Promise.all([immediateEdit, immediateSave]);
		await tick();
		ensure(document.getText().endsWith('!'), 'immediate save lost the last character');
		ensure(b.text === document.getText(), `immediate save did not update the sibling (peer=${b.text}, host=${document.getText()}, dirty=${document.isDirty})`);

		// The two panels take turns editing. Each origin stays ahead locally while
		// its sibling waits for the successful save snapshot.
		const aEdit = { from: a.text.length, to: a.text.length, insert: 'A' };
		a.applyLocal(aEdit);
		await coordinator.enqueueEdit(a, [aEdit], document.version, 1001);
		ensure(b.text !== a.text, 'sibling changed during panel A editing');
		await coordinator.requestSave();
		await tick();
		ensure(a.text === b.text && b.text === document.getText(), 'panel A save did not converge');

		const bEdit = { from: b.text.length, to: b.text.length, insert: 'B' };
		b.applyLocal(bEdit);
		await coordinator.enqueueEdit(b, [bEdit], document.version, 1002);
		ensure(a.text !== b.text, 'sibling changed during panel B editing');
		await coordinator.requestSave();
		await tick();
		ensure(a.text === b.text && a.text === document.getText(), 'panel B save did not converge');

		// A normal source-editor edit has no webview origin, so it is treated as a
		// host-authoritative external update and reaches both panels immediately.
		const sourceEdit = { from: document.getText().length, to: document.getText().length, insert: 'S' };
		await applyWorkspaceChange(document, sourceEdit);
		ensure(a.text === document.getText() && b.text === document.getText(), 'source editor change did not reach both panels');
		const externalUpdateCount = a.externalUpdates.length + b.externalUpdates.length;

		// A failed save never emits the successful-save snapshot to the sibling.
		const snapshotsBeforeFailure = b.savedSnapshots.length;
		const failureEdit = { from: a.text.length, to: a.text.length, insert: 'F' };
		a.applyLocal(failureEdit);
		await coordinator.enqueueEdit(a, [failureEdit], document.version, 1003);
		provider.failWrites = true;
		await coordinator.requestSave();
		await tick();
		ensure(document.isDirty, 'intentional save failure unexpectedly cleaned the document');
		ensure(b.savedSnapshots.length === snapshotsBeforeFailure, 'failed save broadcast a saved snapshot');

		return {
			initialText,
			finalText: document.getText(),
			dirtyAfterEdit,
			siblingUnchangedBeforeSave,
			savedSnapshotCount: b.savedSnapshots.length,
			externalUpdateCount,
			saveFailureBroadcastCount: b.savedSnapshots.length - snapshotsBeforeFailure,
			staleScenarioCount: stale.scenarioCount,
			staleResyncCount: stale.resyncCount,
			staleRetryCount: stale.retryCount,
			staleSaveFailureBroadcastCount: stale.saveFailureBroadcastCount,
			staleFinalText: stale.finalText,
		} satisfies SyncIntegrationReport;
	} finally {
		provider.failWrites = false;
		coordinator?.dispose();
		if (document) {
			try { await document.save(); } catch { /* best effort cleanup */ }
		}
		providerRegistration.dispose();
	}
}
