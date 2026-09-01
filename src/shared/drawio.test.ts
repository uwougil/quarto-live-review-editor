import { describe, it, expect } from 'vitest';
import {
	parseStyle,
	labelToPlainText,
	flattenCells,
	computeBounds,
	buildDiagram,
	isCompressedDiagramBody,
	DrawioUnsupportedError,
	type DrawioVertex,
	type DrawioEdge,
} from './drawio';
import { parseTestXml } from './drawioTestXml';

/** Wraps cells in the `<mxfile>` skeleton every draw.io document has. */
function doc(cells: string, name = 'Page-1'): string {
	return `<mxfile><diagram name="${name}"><mxGraphModel><root>
		<mxCell id="0"/><mxCell id="1" parent="0"/>
		${cells}
	</root></mxGraphModel></diagram></mxfile>`;
}

function build(cells: string) {
	return buildDiagram(parseTestXml(doc(cells)));
}

const vertices = (shapes: readonly unknown[]) =>
	shapes.filter((s) => (s as DrawioVertex).kind === 'vertex') as DrawioVertex[];
const edges = (shapes: readonly unknown[]) => shapes.filter((s) => (s as DrawioEdge).kind === 'edge') as DrawioEdge[];

describe('parseStyle', () => {
	it('reads key=value pairs', () => {
		const style = parseStyle('rounded=1;fillColor=#ff0000;strokeWidth=2');
		expect(style.get('fillcolor')).toBe('#ff0000');
		expect(style.get('strokewidth')).toBe('2');
	});

	// The leading shape name (`ellipse;...`) carries no `=`, and is how draw.io
	// names several of the basic shapes — dropping it loses the shape entirely.
	it('records a bare flag as present', () => {
		const style = parseStyle('ellipse;whiteSpace=wrap;html=1');
		expect(style.has('ellipse')).toBe(true);
		expect(style.get('ellipse')).toBe('1');
	});

	it('is empty for a missing style', () => {
		expect(parseStyle(null).size).toBe(0);
		expect(parseStyle('').size).toBe(0);
	});
});

describe('labelToPlainText', () => {
	it('turns <br> into a line break and drops other tags', () => {
		expect(labelToPlainText('<b>Hello</b><br>World')).toBe('Hello\nWorld');
	});

	it('decodes entities', () => {
		expect(labelToPlainText('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
	});

	// Decoding must happen after tag-stripping, or an escaped tag in the source
	// becomes a real tag and is then stripped — silently losing the text.
	it('keeps an escaped tag as visible text', () => {
		expect(labelToPlainText('&lt;b&gt;bold&lt;/b&gt;')).toBe('<b>bold</b>');
	});

	it('decodes numeric entities including CJK', () => {
		expect(labelToPlainText('&#x65E5;&#x672C;')).toBe('日本');
	});
});

describe('flattenCells / buildDiagram', () => {
	it('reads a vertex with its geometry, label and style', () => {
		const { pages } = build(
			`<mxCell id="a" value="Box" style="rounded=1" vertex="1" parent="1">
				<mxGeometry x="10" y="20" width="120" height="60" as="geometry"/>
			</mxCell>`,
		);
		const [box] = vertices(pages[0].shapes);
		expect(box.label).toBe('Box');
		expect(box.geometry).toEqual({ x: 10, y: 20, width: 120, height: 60 });
		expect(box.style.get('rounded')).toBe('1');
	});

	// A child of a container records coordinates relative to that container, so
	// without folding in the parent offset every nested shape stacks at the
	// container's own origin.
	it('resolves a child vertex to absolute coordinates', () => {
		const { pages } = build(
			`<mxCell id="group" vertex="1" parent="1">
				<mxGeometry x="100" y="200" width="300" height="200" as="geometry"/>
			</mxCell>
			<mxCell id="child" value="Inner" vertex="1" parent="group">
				<mxGeometry x="20" y="30" width="80" height="40" as="geometry"/>
			</mxCell>`,
		);
		const child = vertices(pages[0].shapes).find((v) => v.id === 'child')!;
		expect(child.geometry.x).toBe(120);
		expect(child.geometry.y).toBe(230);
	});

	it('resolves nesting more than one level deep', () => {
		const { pages } = build(
			`<mxCell id="outer" vertex="1" parent="1"><mxGeometry x="10" y="10" width="400" height="400" as="geometry"/></mxCell>
			<mxCell id="mid" vertex="1" parent="outer"><mxGeometry x="20" y="20" width="200" height="200" as="geometry"/></mxCell>
			<mxCell id="leaf" vertex="1" parent="mid"><mxGeometry x="5" y="5" width="50" height="50" as="geometry"/></mxCell>`,
		);
		const leaf = vertices(pages[0].shapes).find((v) => v.id === 'leaf')!;
		expect(leaf.geometry).toMatchObject({ x: 35, y: 35 });
	});

	// `parent` is a free id reference, so a hand-edited or corrupt file can
	// describe a cycle. The walk must terminate rather than hang the webview.
	it('terminates on a parent cycle', () => {
		const { pages } = build(
			`<mxCell id="a" vertex="1" parent="b"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="a"><mxGeometry x="2" y="2" width="10" height="10" as="geometry"/></mxCell>`,
		);
		expect(vertices(pages[0].shapes)).toHaveLength(2);
	});

	it('connects an edge to the centres of its source and target', () => {
		const { pages } = build(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="50" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="200" y="100" width="100" height="50" as="geometry"/></mxCell>
			<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry as="geometry"/></mxCell>`,
		);
		const [edge] = edges(pages[0].shapes);
		expect(edge.from).toEqual({ x: 50, y: 25 });
		expect(edge.to).toEqual({ x: 250, y: 125 });
	});

	// draw.io leaves a stale sourcePoint behind after a connection is made; using
	// it would detach the line from the box it visibly joins.
	it('prefers a connected shape over a recorded endpoint', () => {
		const { pages } = build(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="50" as="geometry"/></mxCell>
			<mxCell id="e" edge="1" parent="1" source="a">
				<mxGeometry as="geometry">
					<mxPoint x="999" y="999" as="sourcePoint"/>
					<mxPoint x="300" y="300" as="targetPoint"/>
				</mxGeometry>
			</mxCell>`,
		);
		const [edge] = edges(pages[0].shapes);
		expect(edge.from).toEqual({ x: 50, y: 25 });
		expect(edge.to).toEqual({ x: 300, y: 300 });
	});

	it('reads edge waypoints in order', () => {
		const { pages } = build(
			`<mxCell id="e" edge="1" parent="1">
				<mxGeometry as="geometry">
					<mxPoint x="0" y="0" as="sourcePoint"/>
					<mxPoint x="200" y="200" as="targetPoint"/>
					<Array as="points"><mxPoint x="100" y="0"/><mxPoint x="100" y="200"/></Array>
				</mxGeometry>
			</mxCell>`,
		);
		const [edge] = edges(pages[0].shapes);
		expect(edge.waypoints).toEqual([
			{ x: 100, y: 0 },
			{ x: 100, y: 200 },
		]);
	});

	// When a shape carries metadata, draw.io moves the mxCell inside an <object>
	// that owns the id and the label — reading only mxCell loses both.
	it('reads a cell wrapped in an <object>', () => {
		const { pages } = build(
			`<object id="wrapped" label="Labelled">
				<mxCell style="rounded=1" vertex="1" parent="1">
					<mxGeometry x="0" y="0" width="80" height="40" as="geometry"/>
				</mxCell>
			</object>`,
		);
		const [box] = vertices(pages[0].shapes);
		expect(box.id).toBe('wrapped');
		expect(box.label).toBe('Labelled');
	});

	// A relative vertex is an edge label, not a box; drawing it puts a stray
	// rectangle in the corner of the diagram.
	it('skips a relative vertex (edge label)', () => {
		const { pages } = build(
			`<mxCell id="lbl" value="yes" vertex="1" parent="e" relative="1">
				<mxGeometry x="-0.2" y="0" as="geometry"/>
			</mxCell>`,
		);
		expect(vertices(pages[0].shapes)).toHaveLength(0);
	});

	it('ignores the two implicit root cells', () => {
		const { pages } = build('');
		expect(pages[0].shapes).toHaveLength(0);
	});

	it('reads every page of a multi-page file', () => {
		const xml = `<mxfile>
			<diagram name="First"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
				<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>
			</root></mxGraphModel></diagram>
			<diagram name="Second"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
				<mxCell id="b" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>
			</root></mxGraphModel></diagram>
		</mxfile>`;
		const { pages } = buildDiagram(parseTestXml(xml));
		expect(pages.map((p) => p.name)).toEqual(['First', 'Second']);
	});

	// A code fence typically holds just the model, with no <mxfile>/<diagram>.
	it('accepts a bare <mxGraphModel>', () => {
		const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
			<mxCell id="a" value="Bare" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
		</root></mxGraphModel>`;
		const { pages } = buildDiagram(parseTestXml(xml));
		expect(vertices(pages[0].shapes)[0].label).toBe('Bare');
	});
});

describe('isCompressedDiagramBody', () => {
	it('detects a base64 payload', () => {
		expect(isCompressedDiagramBody('7VjbcpswEP0aPXqdwEP0aPXqdwEP')).toBe(true);
	});

	it('does not flag inline XML', () => {
		expect(isCompressedDiagramBody('<mxGraphModel><root/></mxGraphModel>')).toBe(false);
	});

	it('does not flag an empty body', () => {
		expect(isCompressedDiagramBody('   ')).toBe(false);
	});
});

describe('buildDiagram error reporting', () => {
	// A compressed file yields zero cells, which is indistinguishable from a
	// corrupt one unless it is called out explicitly.
	it('reports a compressed document as unsupported', () => {
		const xml = '<mxfile><diagram name="P">7VjbcpswEP0aPXqdwEP0aPXq</diagram></mxfile>';
		expect(() => buildDiagram(parseTestXml(xml))).toThrow(DrawioUnsupportedError);
	});

	it('reports a document with no diagram', () => {
		expect(() => buildDiagram(parseTestXml('<html><body/></html>'))).toThrow(DrawioUnsupportedError);
	});
});

describe('computeBounds', () => {
	it('covers every shape with padding', () => {
		expect(flattenCells([])).toEqual([]);
		const { pages } = build(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="100" y="100" width="50" height="50" as="geometry"/></mxCell>`,
		);
		const b = pages[0].bounds;
		expect(b.x).toBeLessThan(100);
		expect(b.x + b.width).toBeGreaterThan(150);
	});

	// A connector routed around its shapes extends past their boxes; if bounds
	// ignored waypoints the line would be clipped at the diagram border.
	it('includes edge waypoints', () => {
		const { pages } = build(
			`<mxCell id="e" edge="1" parent="1">
				<mxGeometry as="geometry">
					<mxPoint x="0" y="0" as="sourcePoint"/>
					<mxPoint x="10" y="0" as="targetPoint"/>
					<Array as="points"><mxPoint x="5" y="500"/></Array>
				</mxGeometry>
			</mxCell>`,
		);
		expect(pages[0].bounds.height).toBeGreaterThan(500);
	});

	it('gives an empty page a usable viewBox', () => {
		expect(computeBounds([]).width).toBeGreaterThan(0);
		expect(computeBounds([]).height).toBeGreaterThan(0);
	});
});
