import { describe, expect, it } from 'vitest';
import { TokenizationGate } from './tokenizationGuard';

describe('TokenizationGate', () => {
	it('accepts only the newest generation for the current document version', () => {
		const gate = new TokenizationGate();
		const old = gate.begin(4);
		const current = gate.begin(5);
		expect(gate.canPublish(old, 4)).toBe(false);
		expect(gate.canPublish(current, 4)).toBe(false);
		expect(gate.canPublish(current, 5)).toBe(true);
	});

	it('invalidates outstanding work when disposed', () => {
		const gate = new TokenizationGate();
		const ticket = gate.begin(1);
		gate.invalidate();
		expect(gate.canPublish(ticket, 1)).toBe(false);
	});
});

