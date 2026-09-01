import { describe, it, expect } from 'vitest';
import { isDiagramLang } from './diagramLang';
import { isDrawioPath } from './drawioFileClient';

describe('isDiagramLang', () => {
	it('recognises mermaid', () => {
		expect(isDiagramLang('mermaid')).toBe('mermaid');
	});

	it('recognises the draw.io fence tags', () => {
		expect(isDiagramLang('drawio')).toBe('drawio');
		expect(isDiagramLang('diagrams.net')).toBe('drawio');
		expect(isDiagramLang('mxgraph')).toBe('drawio');
	});

	// A fence tagged `xml` is ordinary XML the author wants shown as code —
	// rendering it as a diagram would silently hide the text they wrote.
	it('does not treat plain xml as a diagram', () => {
		expect(isDiagramLang('xml')).toBeNull();
	});

	it('returns null for ordinary code languages', () => {
		for (const lang of ['ts', 'js', 'python', 'html', '']) {
			expect(isDiagramLang(lang)).toBeNull();
		}
	});
});

describe('isDrawioPath', () => {
	it('matches the raw XML extensions', () => {
		expect(isDrawioPath('diagram.drawio')).toBe(true);
		expect(isDrawioPath('a/b/c.dio')).toBe(true);
		expect(isDrawioPath('x.drawio.xml')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isDrawioPath('Diagram.DRAWIO')).toBe(true);
	});

	// These are real images that an <img> already renders correctly; routing them
	// through the diagram widget would replace a perfect rendering with an
	// approximate one.
	it('leaves the editable-export image formats to <img>', () => {
		expect(isDrawioPath('diagram.drawio.svg')).toBe(false);
		expect(isDrawioPath('diagram.drawio.png')).toBe(false);
	});

	it('ignores a query string or fragment', () => {
		expect(isDrawioPath('d.drawio?v=2')).toBe(true);
		expect(isDrawioPath('d.drawio#page1')).toBe(true);
	});

	it('does not match ordinary images', () => {
		expect(isDrawioPath('photo.png')).toBe(false);
		expect(isDrawioPath('chart.svg')).toBe(false);
	});
});
