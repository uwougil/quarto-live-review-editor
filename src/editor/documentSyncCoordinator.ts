import * as vscode from 'vscode';
import type { TextChange } from '../shared/messages';
import { createSyncTrace, snapshotFields, type SyncTrace } from './syncTrace';

export type SaveSource = 'webview' | 'native' | 'coordinator';

export interface DocumentSyncPeer {
	/** Whether this peer is the currently active editor. Undefined keeps test/legacy peers active. */
	readonly active?: boolean;
	readonly panelId?: string;
	receiveDocumentChanges(changes: TextChange[], baseVersion: number, version: number): void;
	receiveSavedSnapshot(text: string, version: number): void;
	acknowledgeEdit(editId: number, version: number): void;
	resync(rejectedEditId?: number): void;
	requestSaveBarrier(barrierId: number): Promise<void>;
	runHistoryCommand(command: 'undo' | 'redo'): Promise<void>;
}

interface PendingMutation {
	readonly peer: DocumentSyncPeer;
	readonly editId: number;
	readonly baseVersion: number;
	readonly changesKey: string;
	readonly expectedVersion: number;
	eventVersion?: number;
}

function changesKey(changes: readonly TextChange[]): string {
	return JSON.stringify([...changes].sort((a, b) => (
		a.from - b.from || a.to - b.to || a.insert.localeCompare(b.insert)
	)));
}

/** The single mutation and change-dispatch boundary for one TextDocument URI. */
export class DocumentSyncCoordinator implements vscode.Disposable {
	private readonly peers = new Set<DocumentSyncPeer>();
	private readonly changeListener: vscode.Disposable;
	private readonly willSaveListener: vscode.Disposable;
	private readonly didSaveListener: vscode.Disposable;
	private queue: Promise<void> = Promise.resolve();
	private readonly pendingMutations: PendingMutation[] = [];
	private readonly pendingWaiters = new Set<() => void>();
	private readonly saveBarrierWaiters = new Map<DocumentSyncPeer, Set<() => void>>();
	private lastObservedVersion: number;
	private saveInProgress = 0;
	private nextSaveBarrierId = 1;
	private saveBarrierInFlight: Promise<void> | undefined;
	private disposed = false;
	private readonly trace: SyncTrace;

	constructor(private readonly document: vscode.TextDocument) {
		this.trace = createSyncTrace(document.uri.toString());
		this.log('coordinator-created');
		this.lastObservedVersion = document.version;
		this.changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.toString() === document.uri.toString()) this.handleDocumentChanged(event);
		});
		this.willSaveListener = vscode.workspace.onWillSaveTextDocument((event) => {
			if (event.document.uri.toString() !== document.uri.toString()) return;
			if (this.saveInProgress > 0) {
				this.log('willSave-skipped', { source: 'native', reason: 'coordinator-save-in-progress' });
				return;
			}
			// Native/Workbench saves share the same in-flight barrier as a webview
			// Mod-S request. Cursor can route one physical Ctrl+S through both paths;
			// coalescing here keeps that from doubling the peer round-trip.
			this.log('willSave', { source: 'native' });
			event.waitUntil(this.waitForSaveBarrier('native'));
		});
		this.didSaveListener = vscode.workspace.onDidSaveTextDocument((savedDocument) => {
			if (savedDocument.uri.toString() !== document.uri.toString()) return;
			this.log('didSave', { source: this.saveInProgress > 0 ? 'coordinator' : 'native', ...snapshotFields(this.document.getText()), savedSnapshotVersion: this.document.version });
			this.broadcastSavedSnapshot();
		});
	}

	get traceEnabled(): boolean { return this.trace.enabled; }
	get traceId(): number { return this.trace.id; }
	get syncTrace(): SyncTrace { return this.trace; }
	get pendingMutationCount(): number { return this.pendingMutations.length; }

	addPeer(peer: DocumentSyncPeer): void {
		this.peers.add(peer);
		this.log('peer-added', { panelId: peer.panelId, panelActive: peer.active !== false });
	}
	removePeer(peer: DocumentSyncPeer): void {
		this.peers.delete(peer);
		this.log('peer-removed', { panelId: peer.panelId });
		const waiters = this.saveBarrierWaiters.get(peer);
		if (waiters) {
			for (const resolve of waiters) resolve();
			this.saveBarrierWaiters.delete(peer);
		}
		for (let index = this.pendingMutations.length - 1; index >= 0; index--) {
			if (this.pendingMutations[index].peer === peer) this.pendingMutations.splice(index, 1);
		}
		this.resolvePendingWaitersIfSettled();
	}
	get peerCount(): number { return this.peers.size; }

	/** Test/support hook for callers that need the native queue fully settled. */
	async waitForIdle(): Promise<void> {
		await this.queue.catch(() => undefined);
		await this.waitForPendingMutations();
	}

	/** Save after edits already accepted by the host and the active peer have settled. */
	requestSave(): Promise<void> {
		this.log('save-request', { source: 'webview' });
		return this.waitForSaveBarrier('webview').then(() => this.enqueue(async () => {
			await this.waitForPendingMutations();
			// If a concurrent native/Workbench save already completed while this
			// request was waiting at the shared barrier, there is nothing left to
			// write. This also avoids a second onDidSave/savedSnapshot cycle.
			if (this.document.isDirty === false) return;
			this.log('document-save', { source: 'coordinator' });
			this.saveInProgress++;
			try {
				await this.document.save();
			} finally {
				this.saveInProgress--;
			}
		}));
	}

	enqueueEdit(peer: DocumentSyncPeer, changes: TextChange[], baseVersion: number, editId: number): Promise<void> {
		this.log('enqueue-mutation', { panelId: peer.panelId, panelActive: peer.active !== false, editId, baseVersion });
		return this.enqueue(async () => {
			if (!this.peers.has(peer)) return;
			if (baseVersion !== this.document.version) {
				peer.resync(editId);
				return;
			}
			if (changes.length === 0) {
				peer.acknowledgeEdit(editId, this.document.version);
				return;
			}

			const edit = new vscode.WorkspaceEdit();
			for (const change of changes) {
				if (change.from < 0 || change.to < change.from || change.to > this.document.getText().length) {
					peer.resync(editId);
					return;
				}
				edit.replace(this.document.uri, new vscode.Range(
					this.document.positionAt(change.from), this.document.positionAt(change.to),
				), change.insert);
			}

			// Keep an identity for the exact mutation rather than a time-based owner.
			// VS Code may deliver onDidChangeTextDocument after applyEdit() returns or
			// resolves, while unrelated document changes may occur in between.
			const pending: PendingMutation = {
				peer,
				editId,
				baseVersion,
				changesKey: changesKey(changes),
				expectedVersion: baseVersion + 1,
			};
			this.pendingMutations.push(pending);
			let applyResult: Thenable<boolean>;
			try {
				applyResult = vscode.workspace.applyEdit(edit);
			} catch {
				this.forgetPending(pending);
				if (this.peers.has(peer)) peer.resync(editId);
				return;
			}
			let applied = false;
			try {
				applied = await applyResult;
			} catch {
				applied = false;
			}
			if (!applied) {
				this.forgetPending(pending);
				if (this.peers.has(peer)) peer.resync(editId);
				return;
			}
			// A successful no-op does not produce a document-change event.
			if (pending.eventVersion === undefined && this.document.version === baseVersion) {
				this.forgetPending(pending);
				if (this.peers.has(peer)) peer.acknowledgeEdit(editId, baseVersion);
			}
		});
	}

	enqueueCommand(peer: DocumentSyncPeer, command: 'undo' | 'redo'): Promise<void> {
		return this.enqueue(async () => {
			if (!this.peers.has(peer)) return;
			await peer.runHistoryCommand(command);
		});
	}

	/** Queue a host-originated document mutation (for example image paste). */
	enqueueHostMutation(mutation: () => Thenable<unknown> | Promise<unknown>): Promise<void> {
		return this.enqueue(async () => { await mutation(); });
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.queue.catch(() => undefined).then(operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private handleDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		if (event.contentChanges.length === 0) return;
		const eventVersion = event.document.version;
		const previousVersion = this.lastObservedVersion;
		const changes = event.contentChanges.map((change) => ({
			from: change.rangeOffset,
			to: change.rangeOffset + change.rangeLength,
			insert: change.text,
		}));
		const eventKey = changesKey(changes);
		const mutationIndex = this.pendingMutations.findIndex((pending) => (
			pending.expectedVersion === eventVersion && pending.changesKey === eventKey
		));
		const mutation = mutationIndex >= 0 ? this.pendingMutations.splice(mutationIndex, 1)[0] : undefined;
		if (mutation) {
			mutation.eventVersion = eventVersion;
			if (this.peers.has(mutation.peer)) {
				mutation.peer.acknowledgeEdit(mutation.editId, eventVersion);
			}
			this.resolvePendingWaitersIfSettled();
		}
		this.log('document-change', {
			matchedEditId: mutation?.editId,
			baseVersion: mutation?.baseVersion ?? Math.max(0, eventVersion - 1),
			version: eventVersion,
			pendingMutationCount: this.pendingMutations.length,
		});

		// A delayed event can arrive after a newer event has already been observed.
		// Never move an unmatched mutation's expected version: its resulting version
		// is part of the operation identity and must remain stable until that exact
		// event arrives. Derive an unmatched event's base from its version when it
		// has skipped an event that has not reached this listener yet, while retaining
		// the last observed value as a floor for normal in-order delivery.
		const baseVersion = mutation?.baseVersion ?? Math.max(
			0,
			eventVersion > previousVersion ? Math.max(previousVersion, eventVersion - 1) : eventVersion - 1,
		);
		if (eventVersion > previousVersion) this.lastObservedVersion = eventVersion;
		// A webview-originated mutation is the save barrier: sibling panels keep
		// their old snapshot until onDidSaveTextDocument. If its originating panel
		// closed before a delayed change event arrived, remaining peers still need
		// the committed host change.
		if (!mutation || !this.peers.has(mutation.peer)) {
			for (const peer of this.peers) peer.receiveDocumentChanges(changes, baseVersion, eventVersion);
		}
	}

	private waitForSaveBarrier(source: SaveSource): Promise<void> {
		if (this.saveBarrierInFlight) return this.saveBarrierInFlight;
		this.log('save-barrier-start', { source });

		const barrier = this.queue.catch(() => undefined).then(async () => {
			// Only the active custom editor is allowed to flush webview-local input
			// into this save. Hidden retained webviews can legitimately contain stale
			// unsent ChangeSets; flushing them here makes Ctrl+S appear to roll back
			// the active editor. Their local state remains intact and can be rebased/
			// sent later, at which point the document becomes dirty again normally.
			const activePeers = [...this.peers].filter((peer) => peer.active !== false);
			this.log('save-barrier-peers', { source, activePeerCount: activePeers.length, pendingMutationCount: this.pendingMutations.length });
			if (activePeers.length > 0) {
				const barrierId = this.nextSaveBarrierId++;
				this.log('save-barrier-request', { source, barrierId, activePeerCount: activePeers.length });
				// Request the barrier only after the current host queue is idle so an
				// active peer's retry can enqueue work without waiting behind itself.
				await Promise.all(activePeers.map((peer) => this.requestPeerSaveBarrier(peer, barrierId)));
			}
			// Edits already accepted by the host still belong to the canonical save,
			// regardless of which panel originated them.
			await this.queue.catch(() => undefined);
			await this.waitForPendingMutations();
			this.log('save-barrier-settled', { source, barrierId: activePeers.length > 0 ? this.nextSaveBarrierId - 1 : undefined });
		});

		let tracked!: Promise<void>;
		tracked = barrier.finally(() => {
			if (this.saveBarrierInFlight === tracked) this.saveBarrierInFlight = undefined;
		});
		this.saveBarrierInFlight = tracked;
		return tracked;
	}

	private requestPeerSaveBarrier(peer: DocumentSyncPeer, barrierId: number): Promise<void> {
		this.log('peer-save-barrier', { panelId: peer.panelId, panelActive: peer.active !== false, barrierId });
		return new Promise((resolve) => {
			let waiters = this.saveBarrierWaiters.get(peer);
			if (!waiters) {
				waiters = new Set();
				this.saveBarrierWaiters.set(peer, waiters);
			}
			let settled = false;
			const settle = () => {
				if (settled) return;
				settled = true;
				waiters!.delete(settle);
				if (waiters!.size === 0) this.saveBarrierWaiters.delete(peer);
				this.log('peer-save-barrier-settled', { panelId: peer.panelId, panelActive: peer.active !== false, barrierId });
				resolve();
			};
			waiters.add(settle);
			try {
				void peer.requestSaveBarrier(barrierId).then(settle, settle);
			} catch {
				settle();
			}
		});
	}

	private waitForPendingMutations(): Promise<void> {
		if (this.pendingMutations.length === 0 || this.disposed) return Promise.resolve();
		return new Promise((resolve) => this.pendingWaiters.add(resolve));
	}

	private resolvePendingWaitersIfSettled(): void {
		if (this.pendingMutations.length !== 0) return;
		for (const resolve of this.pendingWaiters) resolve();
		this.pendingWaiters.clear();
	}

	private broadcastSavedSnapshot(): void {
		const text = this.document.getText();
		const version = this.document.version;
		this.log('saved-snapshot-broadcast', { savedSnapshotVersion: version, ...snapshotFields(text) });
		for (const peer of this.peers) peer.receiveSavedSnapshot(text, version);
	}

	private forgetPending(mutation: PendingMutation): void {
		const index = this.pendingMutations.indexOf(mutation);
		if (index >= 0) this.pendingMutations.splice(index, 1);
		this.resolvePendingWaitersIfSettled();
	}

	private log(type: string, fields: Record<string, boolean | number | string | undefined> = {}): void {
		this.trace.event(type, {
			docVersion: this.document.version,
			dirty: this.document.isDirty,
			pendingMutations: this.pendingMutations.length,
			...fields,
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.peers.clear();
		for (const waiters of this.saveBarrierWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.saveBarrierWaiters.clear();
		this.pendingMutations.length = 0;
		this.resolvePendingWaitersIfSettled();
		this.changeListener.dispose();
		this.willSaveListener.dispose();
		this.didSaveListener.dispose();
	}
}
