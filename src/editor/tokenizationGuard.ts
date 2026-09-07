export interface TokenizationTicket {
	generation: number;
	version: number;
}

/** Rejects async highlighting work that no longer describes the active snapshot. */
export class TokenizationGate {
	private generation = 0;

	begin(version: number): TokenizationTicket {
		return { generation: ++this.generation, version };
	}

	canPublish(ticket: TokenizationTicket, currentVersion: number): boolean {
		return ticket.generation === this.generation && ticket.version === currentVersion;
	}

	invalidate(): void {
		this.generation++;
	}
}

