import { describe, expect, it } from 'vitest';
import { selectActiveSession } from './activeSession';

describe('selectActiveSession', () => {
	it('chooses the active panel when two sessions display the same URI', () => {
		const first = { uriKey: 'file:///same.qmd', active: false, id: 1 };
		const second = { uriKey: 'file:///same.qmd', active: true, id: 2 };
		expect(selectActiveSession([first, second], first.uriKey)).toBe(second);
	});

	it('does not guess when duplicate sessions have no active panel', () => {
		const sessions = [
			{ uriKey: 'file:///same.qmd', active: false },
			{ uriKey: 'file:///same.qmd', active: false },
		];
		expect(selectActiveSession(sessions, 'file:///same.qmd')).toBeUndefined();
	});

	it('falls back to the sole matching session', () => {
		const only = { uriKey: 'file:///one.qmd', active: false };
		expect(selectActiveSession([only], only.uriKey)).toBe(only);
	});
});

