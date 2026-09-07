import * as vscode from 'vscode';
import type { TextChange } from '../shared/messages';

export interface DocumentSyncPeer {
	receiveDocumentChanges(changes: TextChange[], baseVersion: number, version: number): void;
	acknowledgeEdit(editId: number, version: number): void;
	resync(rejectedEditId?: number): void;
}

/** The single mutation and change-dispatch boundary for one TextDocument URI. */
export class DocumentSyncCoordinator implements vscode.Disposable {
	private readonly peers = new Set<DocumentSyncPeer>();
	private readonly changeListener: vscode.Disposable;
	private queue: Promise<void> = Promise.resolve();
	private operationOwner: DocumentSyncPeer | undefined;
	private lastObservedVersion: number;
	private disposed = false;

	constructor(private readonly document: vscode.TextDocument) {
		this.lastObservedVersion = document.version;
		this.changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.toString() === document.uri.toString()) this.handleDocumentChanged(event);
		});
	}

	addPeer(peer: DocumentSyncPeer): void { this.peers.add(peer); }
	removePeer(peer: DocumentSyncPeer): void { this.peers.delete(peer); }
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

			// VS Code normally dispatches the document-change event synchronously
			// inside applyEdit(). Limit ownership to that call itself so an unrelated
			// external edit cannot be hidden while the returned Thenable is pending.
			let applyResult: Thenable<boolean>;
			this.operationOwner = peer;
			try {
				applyResult = vscode.workspace.applyEdit(edit);
			} catch {
				this.operationOwner = undefined;
				peer.resync(editId);
				return;
			} finally {
				this.operationOwner = undefined;
			}
			let applied = false;
			try {
				applied = await applyResult;
			} catch {
				applied = false;
			}
			if (!applied) {
				peer.resync(editId);
				return;
			}
			if (this.peers.has(peer)) peer.acknowledgeEdit(editId, this.document.version);
		});
	}

	enqueueCommand(command: 'undo' | 'redo'): Promise<void> {
		return this.enqueue(async () => { await vscode.commands.executeCommand(command); });
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
		for (const peer of this.peers) {
			if (peer !== this.operationOwner) peer.receiveDocumentChanges(changes, baseVersion, event.document.version);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.peers.clear();
		this.changeListener.dispose();
	}
}
