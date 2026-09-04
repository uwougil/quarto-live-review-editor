import { describe, expect, it } from 'vitest';
import { documentDialectForPath } from './dialect';

describe('documentDialectForPath', () => {
	it('distinguishes Quarto documents from ordinary Markdown', () => {
		expect(documentDialectForPath('notes.md')).toBe('markdown');
		expect(documentDialectForPath('research.QMD')).toBe('quarto');
		expect(documentDialectForPath('README.markdown')).toBe('markdown');
	});
});
