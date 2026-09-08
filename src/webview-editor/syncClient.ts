import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import type { TextChange } from '../shared/messages';

export interface OutboundEdit {
	editId: number;
	baseVersion: number;
	changes: TextChange[];
}

export interface ExternalUpdateInput {
	baseVersion: number;
	version: number;
	changes: TextChange[];
}

export interface ResyncInput {
	text: string;
	version: number;
	rejectedEditId?: number;
}

export interface SyncTransition {
	viewChanges: ChangeSet;
	resyncRequired: boolean;
}

interface InFlightEdit {
	editId: number;
	changes: ChangeSet;
	needsRetry: boolean;
}

function asText(value: string): Text {
	return Text.of(value.split('\n'));
}

function toSpecs(changes: TextChange[]): ChangeSpec[] {
	return changes.map(({ from, to, insert }) => ({ from, to, insert }));
}

function toTextChanges(changes: ChangeSet): TextChange[] {
	const result: TextChange[] = [];
	changes.iterChanges((from, to, _fromB, _toB, inserted) => {
		result.push({ from, to, insert: inserted.toString() });
	});
	return result;
}

function diffAsChangeSet(before: Text, after: string): ChangeSet {
	const oldValue = before.toString();
	if (oldValue === after) return ChangeSet.of([], before.length);
	let prefix = 0;
	const maxPrefix = Math.min(oldValue.length, after.length);
	while (prefix < maxPrefix && oldValue.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
	let oldSuffix = oldValue.length;
	let newSuffix = after.length;
	while (oldSuffix > prefix && newSuffix > prefix && oldValue.charCodeAt(oldSuffix - 1) === after.charCodeAt(newSuffix - 1)) {
		oldSuffix--;
		newSuffix--;
	}
	return ChangeSet.of({ from: prefix, to: oldSuffix, insert: after.slice(prefix, newSuffix) }, before.length);
}

/**
 * Version-aware webview sync state. Local edits remain represented as
 * ChangeSets until the host acknowledges them, so external updates and full
 * resyncs can be operationally transformed without dropping user input.
 */
export class EditorSyncClient {
	private confirmed: Text;
	private version: number;
	private pending: ChangeSet | null = null;
	private inFlight: InFlightEdit | null = null;
	private saveRequested = false;
	private nextEditId = 1;

	constructor(text: string, version: number) {
		this.confirmed = asText(text);
		this.version = version;
	}

	get hostVersion(): number {
		return this.version;
	}

	get hasOutstandingEdits(): boolean {
		return this.inFlight !== null || (this.pending !== null && !this.pending.empty);
	}

	get hasInFlightEdit(): boolean {
		return this.inFlight !== null;
	}

	get hasPendingSave(): boolean {
		return this.saveRequested;
	}

	mapHostPosition(pos: number): number {
		return this.outstandingChanges()?.mapPos(pos, 1) ?? pos;
	}

	recordLocal(changes: ChangeSet): void {
		if (changes.empty) return;
		this.pending = this.pending ? this.pending.compose(changes) : changes;
	}

	requestSave(): void {
		// A stale panel may need a host resync before its in-flight edit can be
		// retried. Keep save behind that rebase so the retry cannot land after the
		// save and appear to have been lost.
		this.saveRequested = true;
	}

	takeSaveRequest(): boolean {
		if (!this.saveRequested || this.hasOutstandingEdits) return false;
		this.saveRequested = false;
		return true;
	}

	takeNextEdit(): OutboundEdit | null {
		if (this.inFlight || !this.pending || this.pending.empty) return null;
		const changes = this.pending;
		this.pending = null;
		const editId = this.nextEditId++;
		this.inFlight = { editId, changes, needsRetry: false };
		return { editId, baseVersion: this.version, changes: toTextChanges(changes) };
	}

	acknowledge(editId: number, version: number): { resyncRequired: boolean } {
		if (!this.inFlight || this.inFlight.editId !== editId || this.inFlight.needsRetry) {
			return { resyncRequired: true };
		}
		this.confirmed = this.inFlight.changes.apply(this.confirmed);
		this.inFlight = null;
		this.version = version;
		return { resyncRequired: false };
	}

	receiveExternal(message: ExternalUpdateInput): SyncTransition {
		const local = this.outstandingChanges();
		const currentLength = local?.newLength ?? this.confirmed.length;
		if (message.baseVersion !== this.version) {
			return { viewChanges: ChangeSet.of([], currentLength), resyncRequired: true };
		}

		const remote = ChangeSet.of(toSpecs(message.changes), this.confirmed.length);
		const viewChanges = local ? remote.map(local, true) : remote;
		const rebased = local ? local.map(remote) : null;
		this.confirmed = remote.apply(this.confirmed);
		this.version = message.version;

		if (this.inFlight) {
			this.inFlight = { ...this.inFlight, changes: rebased!, needsRetry: true };
			this.pending = null;
		} else {
			this.pending = rebased && !rebased.empty ? rebased : null;
		}
		return { viewChanges, resyncRequired: false };
	}

	receiveResync(message: ResyncInput): SyncTransition {
		const local = this.outstandingChanges();
		const remote = diffAsChangeSet(this.confirmed, message.text);
		const viewChanges = local ? remote.map(local, true) : remote;
		const rebased = local ? local.map(remote) : null;
		this.confirmed = asText(message.text);
		this.version = message.version;
		this.inFlight = null;
		this.pending = rebased && !rebased.empty ? rebased : null;
		return { viewChanges, resyncRequired: false };
	}

	receiveSavedSnapshot(message: ResyncInput): SyncTransition {
		// A delayed save event must never roll a panel back over a newer host
		// version. Otherwise a later save notification could create a stale loop.
		if (message.version < this.version) {
			const length = this.outstandingChanges()?.newLength ?? this.confirmed.length;
			return { viewChanges: ChangeSet.of([], length), resyncRequired: false };
		}
		return this.receiveResync(message);
	}

	private outstandingChanges(): ChangeSet | null {
		if (this.inFlight && this.pending) return this.inFlight.changes.compose(this.pending);
		return this.inFlight?.changes ?? this.pending;
	}
}
