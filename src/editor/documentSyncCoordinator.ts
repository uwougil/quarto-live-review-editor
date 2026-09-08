import * as vscode from 'vscode';
import type { TextChange } from '../shared/messages';

export interface DocumentSyncPeer {
	receiveDocumentChanges(changes: TextChange[], baseVersion: number, version: number): void;
	acknowledgeEdit(editId: number, version: number): void;
	resync(rejectedEditId?: number): void;
	runHistoryCommand(command: 'undo' | 'redo'): Promise<void>;
}

interface PendingMutation {
	readonly peer: DocumentSyncPeer;
	readonly editId: number;
	readonly changesKey: string;
	expectedVersion: number;
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
	private queue: Promise<void> = Promise.resolve();
	private readonly pendingMutations: PendingMutation[] = [];
	private lastObservedVersion: number;
	private disposed = false;

	constructor(private readonly document: vscode.TextDocument) {
		this.lastObservedVersion = document.version;
		this.changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.toString() === document.uri.toString()) this.handleDocumentChanged(event);
		});
	}

	addPeer(peer: DocumentSyncPeer): void { this.peers.add(peer); }
	removePeer(peer: DocumentSyncPeer): void {
		this.peers.delete(peer);
		for (let index = this.pendingMutations.length - 1; index >= 0; index--) {
			if (this.pendingMutations[index].peer === peer) this.pendingMutations.splice(index, 1);
		}
	}
	get peerCount(): number { return this.peers.size; }

	enqueueEdit(peer: DocumentSyncPeer, changes: TextChange[], baseVersion: number, editId: number): Promise<void> {
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
		const baseVersion = this.lastObservedVersion;
		this.lastObservedVersion = event.document.version;
		const changes = event.contentChanges.map((change) => ({
			from: change.rangeOffset,
			to: change.rangeOffset + change.rangeLength,
			insert: change.text,
		}));
		const eventKey = changesKey(changes);
		const mutationIndex = this.pendingMutations.findIndex((pending) => (
			pending.expectedVersion === event.document.version && pending.changesKey === eventKey
		));
		const mutation = mutationIndex >= 0 ? this.pendingMutations.splice(mutationIndex, 1)[0] : undefined;
		if (mutation) {
			mutation.eventVersion = event.document.version;
			if (this.peers.has(mutation.peer)) {
				mutation.peer.acknowledgeEdit(mutation.editId, event.document.version);
			}
		}

		// An unrelated event can legitimately win the next document version while
		// applyEdit() is pending. Move only unmatched identities forward; the exact
		// content still has to match before any origin is excluded.
		for (const pending of this.pendingMutations) {
			if (pending.expectedVersion <= event.document.version) {
				pending.expectedVersion = event.document.version + 1;
			}
		}
		for (const peer of this.peers) {
			if (peer !== mutation?.peer) peer.receiveDocumentChanges(changes, baseVersion, event.document.version);
		}
	}

	private forgetPending(mutation: PendingMutation): void {
		const index = this.pendingMutations.indexOf(mutation);
		if (index >= 0) this.pendingMutations.splice(index, 1);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.peers.clear();
		this.pendingMutations.length = 0;
		this.changeListener.dispose();
	}
}
