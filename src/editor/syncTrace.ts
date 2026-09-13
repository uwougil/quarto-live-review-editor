export interface SyncTraceFields {
	[key: string]: boolean | number | string | undefined;
}

export interface SyncTrace {
	readonly id: number;
	readonly enabled: boolean;
	readonly documentUri: string;
	event(type: string, fields?: SyncTraceFields): void;
}

let nextTraceId = 1;
let nextSequence = 1;
let nextPanelId = 1;

function isEnabled(): boolean {
	return process.env.MLP_SYNC_TRACE === '1';
}

function hashText(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function snapshotFields(text: string): SyncTraceFields {
	return { snapshotLength: text.length, snapshotHash: hashText(text) };
}

export function createSyncTrace(documentUri: string): SyncTrace {
	const id = nextTraceId++;
	const enabled = isEnabled();
	return {
		id,
		enabled,
		documentUri,
		event(type, fields = {}) {
			if (!enabled) return;
			const sequence = nextSequence++;
			const details = Object.entries(fields)
				.filter(([, value]) => value !== undefined)
				.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
				.join(' ');
			console.log(`[sync-trace #${id} seq=${sequence} ts=${Date.now()}] event=${type} docUri=${JSON.stringify(documentUri)}${details ? ` ${details}` : ''}`);
		},
	};
}

export function createSyncPanelId(): string {
	return `panel-${nextPanelId++}`;
}
