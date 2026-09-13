import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import type { TextChange } from '../shared/messages';
import { normalizeLineEndings } from '../shared/textCoordinates';

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

const MAX_SETTLED_EDIT_IDS = 32;

function asText(value: string): Text {
	return Text.of(normalizeLineEndings(value).split('\n'));
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
	after = normalizeLineEndings(after);
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

interface ChangeRange {
	from: number;
	to: number;
}

function outputRanges(changes: ChangeSet): ChangeRange[] {
	const ranges: ChangeRange[] = [];
	changes.iterChanges((_fromA, _toA, fromB, toB) => ranges.push({ from: fromB, to: toB }));
	return ranges;
}

function touchesOutputRange(changes: ChangeSet, ranges: ChangeRange[]): boolean {
	let touches = false;
	changes.iterChanges((fromA, toA) => {
		if (touches) return;
		touches = ranges.some(({ from, to }) => {
			if (from === to) return fromA === from;
			if (fromA === toA) return fromA > from && fromA < to;
			return fromA < to && toA > from;
		});
	});
	return touches;
}

function snapshotPreservesChanges(base: Text, local: ChangeSet, snapshot: string): { changes: ChangeSet; preservesLocal: boolean } {
	const localDocument = local.apply(base);
	const changes = diffAsChangeSet(localDocument, snapshot);
	return { changes, preservesLocal: !touchesOutputRange(changes, outputRanges(local)) };
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
	// A canonical saved snapshot can settle an edit before its explicit ack
	// message reaches the webview. Keep that identity long enough to treat the
	// delayed ack as an idempotent confirmation instead of requesting a resync.
	private readonly settledEditIds = new Set<number>();
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

	get hasPendingEdits(): boolean {
		return this.pending !== null && !this.pending.empty;
	}

	get inFlightEditId(): number | undefined {
		return this.inFlight?.editId;
	}

	debugState(): { pending: boolean; inFlightEditId?: number; hostVersion: number } {
		return { pending: this.hasPendingEdits, inFlightEditId: this.inFlightEditId, hostVersion: this.version };
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
		if (this.settledEditIds.delete(editId)) {
			return { resyncRequired: version > this.version };
		}
		if (!this.inFlight || this.inFlight.editId !== editId || this.inFlight.needsRetry) {
			return { resyncRequired: true };
		}
		this.confirmed = this.inFlight.changes.apply(this.confirmed);
		this.inFlight = null;
		this.version = version;
		return { resyncRequired: false };
	}

	private rememberSettledEdit(editId: number): void {
		this.settledEditIds.add(editId);
		while (this.settledEditIds.size > MAX_SETTLED_EDIT_IDS) {
			const oldest = this.settledEditIds.values().next().value;
			if (oldest === undefined) return;
			this.settledEditIds.delete(oldest);
		}
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

		const local = this.outstandingChanges();
		if (local) {
			// Rebase the snapshot from the optimistic local document. If its
			// operational delta does not touch any output range produced by the
			// outstanding local ChangeSet, the snapshot has preserved those edits
			// and only advances canonical state around them.
			const allLocal = snapshotPreservesChanges(this.confirmed, local, message.text);
			if (allLocal.preservesLocal) {
				if (this.inFlight) this.rememberSettledEdit(this.inFlight.editId);
				this.confirmed = asText(message.text);
				this.version = message.version;
				this.inFlight = null;
				this.pending = null;
				return { viewChanges: allLocal.changes, resyncRequired: false };
			}

			// The host may have saved the in-flight prefix while a later local edit
			// is still pending in CodeMirror. Confirm only that prefix and leave the
			// later ChangeSet relative to the new canonical text for the next retry.
			if (this.inFlight) {
				const inFlightSnapshot = snapshotPreservesChanges(this.confirmed, this.inFlight.changes, message.text);
				if (!inFlightSnapshot.preservesLocal) return this.receiveResync(message);
				const pending = this.pending;
				const viewChanges = pending ? inFlightSnapshot.changes.map(pending, true) : inFlightSnapshot.changes;
				const rebased = pending ? pending.map(inFlightSnapshot.changes) : null;
				this.rememberSettledEdit(this.inFlight.editId);
				this.confirmed = asText(message.text);
				this.version = message.version;
				this.inFlight = null;
				this.pending = rebased && !rebased.empty ? rebased : null;
				return { viewChanges, resyncRequired: false };
			}
		}
		return this.receiveResync(message);
	}

	private outstandingChanges(): ChangeSet | null {
		if (this.inFlight && this.pending) return this.inFlight.changes.compose(this.pending);
		return this.inFlight?.changes ?? this.pending;
	}
}
