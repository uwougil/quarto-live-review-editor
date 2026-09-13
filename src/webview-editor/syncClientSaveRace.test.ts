import { ChangeSet, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { EditorSyncClient } from './syncClient';

function apply(value: string, changes: ChangeSet): string {
	return changes.apply(Text.of(value.split('\n'))).toString();
}

describe('EditorSyncClient save races', () => {
	it('does not duplicate an in-flight edit already included in a saved snapshot', () => {
		const client = new EditorSyncClient('abc', 1);
		client.recordLocal(ChangeSet.of({ from: 3, insert: 'X' }, 3));
		const edit = client.takeNextEdit()!;
		let viewText = 'abcX';

		// The host applied X and wrote it to disk, but the ack message is delayed
		// behind the native onDidSave/savedSnapshot delivery.
		const transition = client.receiveSavedSnapshot({ text: 'abcX', version: 2 });
		viewText = apply(viewText, transition.viewChanges);

		expect(viewText).toBe('abcX');
		expect(client.hasOutstandingEdits).toBe(false);
		expect(client.acknowledge(edit.editId, 2).resyncRequired).toBe(false);
	});

	it('settles the acknowledged prefix while preserving a later pending edit', () => {
		const client = new EditorSyncClient('abc', 1);
		client.recordLocal(ChangeSet.of({ from: 3, insert: 'X' }, 3));
		const edit = client.takeNextEdit()!;
		client.recordLocal(ChangeSet.of({ from: 4, insert: 'Y' }, 4));
		let viewText = 'abcXY';

		const transition = client.receiveSavedSnapshot({ text: 'abcX', version: 2 });
		viewText = apply(viewText, transition.viewChanges);

		expect(viewText).toBe('abcXY');
		expect(client.hasOutstandingEdits).toBe(true);
		expect(client.acknowledge(edit.editId, 2).resyncRequired).toBe(false);
		const retry = client.takeNextEdit()!;
		expect(retry.baseVersion).toBe(2);
		expect(apply('abcX', ChangeSet.of(retry.changes, 4))).toBe('abcXY');
	});

	it('keeps local input when native save captured the older confirmed snapshot', () => {
		const client = new EditorSyncClient('abc', 1);
		client.recordLocal(ChangeSet.of({ from: 3, insert: 'X' }, 3));
		client.takeNextEdit();
		let viewText = 'abcX';

		const transition = client.receiveSavedSnapshot({ text: 'abc', version: 1 });
		viewText = apply(viewText, transition.viewChanges);

		expect(viewText).toBe('abcX');
		expect(client.hasOutstandingEdits).toBe(true);
	});

	it('does not replay a hidden retained panel edit after the canonical save snapshot', () => {
		const hidden = new EditorSyncClient('abc', 1);
		hidden.recordLocal(ChangeSet.of({ from: 3, insert: 'H' }, 3));
		const edit = hidden.takeNextEdit()!;
		let viewText = 'abcH';

		// The hidden panel is excluded from the active save barrier, but its edit
		// already reached the host. Its delayed ack and the canonical snapshot can
		// therefore cross in either order.
		const transition = hidden.receiveSavedSnapshot({ text: 'abcH', version: 2 });
		viewText = apply(viewText, transition.viewChanges);

		expect(viewText).toBe('abcH');
		expect(hidden.acknowledge(edit.editId, 2).resyncRequired).toBe(false);
	});

	it('retires an in-flight edit when a saved snapshot also contains an unrelated remote edit', () => {
		const hidden = new EditorSyncClient('abc', 1);
		hidden.recordLocal(ChangeSet.of({ from: 3, insert: 'H' }, 3));
		const edit = hidden.takeNextEdit()!;
		let viewText = 'abcH';

		// H reached the host, then an unrelated active/host edit A was applied
		// before the canonical snapshot arrived. The ack for H is still delayed.
		const transition = hidden.receiveSavedSnapshot({ text: 'abcHA', version: 3 });
		viewText = apply(viewText, transition.viewChanges);

		expect(transition.resyncRequired).toBe(false);
		expect(viewText).toBe('abcHA');
		expect(hidden.hasOutstandingEdits).toBe(false);
		expect(hidden.hostVersion).toBe(3);
		expect(hidden.acknowledge(edit.editId, 3).resyncRequired).toBe(false);
	});
});
