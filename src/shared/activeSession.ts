export interface SessionIdentity {
	uriKey: string;
	active: boolean;
}

/** Selects by panel activity, using URI only to narrow the candidate set. */
export function selectActiveSession<T extends SessionIdentity>(sessions: Iterable<T>, uriKey: string): T | undefined {
	const matching = [...sessions].filter((session) => session.uriKey === uriKey);
	return matching.find((session) => session.active) ?? (matching.length === 1 ? matching[0] : undefined);
}

