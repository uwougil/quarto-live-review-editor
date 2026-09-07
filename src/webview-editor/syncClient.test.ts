import { ChangeSet, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { EditorSyncClient } from './syncClient';

function text(value: string): Text {
	return Text.of(value.split('\n'));
}

function apply(value: string, changes: ChangeSet): string {
	return changes.apply(text(value)).toString();
}

describe('EditorSyncClient', () => {
	it('rebases a pending local edit over an external update without losing either change', () => {
		const client = new EditorSyncClient('abc', 1);
		const local = ChangeSet.of({ from: 1, insert: 'X' }, 3);
		client.recordLocal(local);
		let viewText = apply('abc', local);

		const received = client.receiveExternal({ baseVersion: 1, version: 2, changes: [{ from: 3, to: 3, insert: 'Y' }] });
		expect(received.resyncRequired).toBe(false);
		viewText = apply(viewText, received.viewChanges);
		expect(viewText).toBe('aXbcY');

		const outgoing = client.takeNextEdit();
		expect(outgoing?.baseVersion).toBe(2);
		expect(outgoing && apply('abcY', ChangeSet.of(outgoing.changes, 4))).toBe('aXbcY');
	});

	it('requeues an in-flight edit after a stale-version resync', () => {
		const client = new EditorSyncClient('abc', 1);
		const local = ChangeSet.of({ from: 1, insert: 'X' }, 3);
		client.recordLocal(local);
		const first = client.takeNextEdit()!;
		let viewText = apply('abc', local);

		const external = client.receiveExternal({ baseVersion: 1, version: 2, changes: [{ from: 3, to: 3, insert: 'Y' }] });
		viewText = apply(viewText, external.viewChanges);
		expect(viewText).toBe('aXbcY');

		const resync = client.receiveResync({ text: 'abcY', version: 2, rejectedEditId: first.editId });
		viewText = apply(viewText, resync.viewChanges);
		expect(viewText).toBe('aXbcY');
		const retried = client.takeNextEdit()!;
		expect(retried.baseVersion).toBe(2);
		expect(apply('abcY', ChangeSet.of(retried.changes, 4))).toBe('aXbcY');
	});

	it('serializes a second local edit behind the acknowledgement of the first', () => {
		const client = new EditorSyncClient('abc', 7);
		client.recordLocal(ChangeSet.of({ from: 3, insert: '1' }, 3));
		const first = client.takeNextEdit()!;
		client.recordLocal(ChangeSet.of({ from: 4, insert: '2' }, 4));
		expect(client.takeNextEdit()).toBeNull();
		expect(client.acknowledge(first.editId, 8).resyncRequired).toBe(false);
		const second = client.takeNextEdit()!;
		expect(second.baseVersion).toBe(8);
		expect(apply('abc1', ChangeSet.of(second.changes, 4))).toBe('abc12');
	});

	it('preserves both in-flight and pending edits through a host resync', () => {
		const client = new EditorSyncClient('abc', 1);
		client.recordLocal(ChangeSet.of({ from: 1, insert: 'X' }, 3));
		const first = client.takeNextEdit()!;
		client.recordLocal(ChangeSet.of({ from: 4, insert: 'Z' }, 4));
		let viewText = 'aXbcZ';

		const resync = client.receiveResync({ text: 'abcY', version: 2, rejectedEditId: first.editId });
		viewText = apply(viewText, resync.viewChanges);
		expect(viewText).toBe('aXbcYZ');
		const retry = client.takeNextEdit()!;
		expect(apply('abcY', ChangeSet.of(retry.changes, 4))).toBe(viewText);
	});

	it('requests a resync for an out-of-order acknowledgement without dropping the outstanding edit', () => {
		const client = new EditorSyncClient('abc', 1);
		client.recordLocal(ChangeSet.of({ from: 3, insert: 'X' }, 3));
		const edit = client.takeNextEdit()!;
		expect(client.acknowledge(edit.editId + 1, 2).resyncRequired).toBe(true);
		expect(client.hasOutstandingEdits).toBe(true);
	});

	it('rejects an external update based on an unexpected version without mutating local state', () => {
		const client = new EditorSyncClient('abc', 4);
		client.recordLocal(ChangeSet.of({ from: 1, insert: 'X' }, 3));
		const result = client.receiveExternal({ baseVersion: 3, version: 5, changes: [{ from: 3, to: 3, insert: 'Y' }] });
		expect(result.resyncRequired).toBe(true);
		expect(result.viewChanges.empty).toBe(true);
		expect(client.hostVersion).toBe(4);
		expect(client.hasOutstandingEdits).toBe(true);
	});

	it('maps host cursor positions through every outstanding local edit', () => {
		const client = new EditorSyncClient('abcd', 1);
		client.recordLocal(ChangeSet.of({ from: 0, insert: 'XY' }, 4));
		client.takeNextEdit();
		client.recordLocal(ChangeSet.of({ from: 3, insert: 'Z' }, 6));
		expect(client.mapHostPosition(2)).toBe(5);
	});
});
