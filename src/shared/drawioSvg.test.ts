import { describe, it, expect } from 'vitest';
import { buildDiagram } from './drawio';
import { parseTestXml } from './drawioTestXml';
import {
	renderDiagramSvg,
	sanitizeColor,
	shapeKindOf,
	wrapLabel,
	escapeXml,
	colorLuminance,
	labelColorFor,
	hasContrast,
	isOrthogonalEdge,
	routeOrthogonal,
	fitLabel,
	fixedConnectionPoint,
	LIGHT_THEME,
	DARK_THEME,
} from './drawioSvg';
import { parseStyle } from './drawio';

function render(cells: string, theme = LIGHT_THEME, uid = 'test'): string {
	const xml = `<mxfile><diagram name="P"><mxGraphModel><root>
		<mxCell id="0"/><mxCell id="1" parent="0"/>
		${cells}
	</root></mxGraphModel></diagram></mxfile>`;
	return renderDiagramSvg(buildDiagram(parseTestXml(xml)), theme, uid);
}

const box = (extra: string) =>
	`<mxCell id="a" ${extra} vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="50" as="geometry"/></mxCell>`;

describe('escapeXml', () => {
	it('escapes every character that can break out of markup', () => {
		expect(escapeXml(`<&">'`)).toBe('&lt;&amp;&quot;&gt;&apos;');
	});
});

describe('sanitizeColor', () => {
	it('accepts hex colours', () => {
		expect(sanitizeColor('#ff0000', '#000')).toBe('#ff0000');
		expect(sanitizeColor('#f00', '#000')).toBe('#f00');
	});

	it('accepts plain colour names', () => {
		expect(sanitizeColor('none', '#000')).toBe('none');
		expect(sanitizeColor('red', '#000')).toBe('red');
	});

	// The document is a file the user merely opened: a crafted style must not be
	// able to close the attribute and add markup of its own.
	it('rejects a value that would break out of the attribute', () => {
		expect(sanitizeColor('"><script>alert(1)</script>', '#000')).toBe('#000');
	});

	it('rejects a url() reference', () => {
		expect(sanitizeColor('url(#evil)', '#000')).toBe('#000');
	});

	it('falls back for a missing value', () => {
		expect(sanitizeColor(undefined, '#123456')).toBe('#123456');
	});
});

describe('shapeKindOf', () => {
	it('detects the bare shape flags', () => {
		expect(shapeKindOf(parseStyle('ellipse;html=1'))).toBe('ellipse');
		expect(shapeKindOf(parseStyle('rhombus;html=1'))).toBe('rhombus');
		expect(shapeKindOf(parseStyle('triangle'))).toBe('triangle');
	});

	it('detects shape=<name>', () => {
		expect(shapeKindOf(parseStyle('shape=cylinder;html=1'))).toBe('cylinder');
		expect(shapeKindOf(parseStyle('shape=hexagon'))).toBe('hexagon');
		expect(shapeKindOf(parseStyle('shape=note'))).toBe('note');
	});

	// A style may carry both spellings; the explicit `shape=` is the real one.
	it('prefers shape=<name> over a bare flag', () => {
		expect(shapeKindOf(parseStyle('ellipse;shape=cylinder'))).toBe('cylinder');
	});

	it('reads rounded and plain rectangles', () => {
		expect(shapeKindOf(parseStyle('rounded=1'))).toBe('rounded');
		expect(shapeKindOf(parseStyle('rounded=0;whiteSpace=wrap'))).toBe('rectangle');
		expect(shapeKindOf(parseStyle(''))).toBe('rectangle');
	});

	it('treats a text style as a label with no outline', () => {
		expect(shapeKindOf(parseStyle('text;html=1;align=left'))).toBe('text');
	});

	it('falls back to a rectangle for an unknown shape', () => {
		expect(shapeKindOf(parseStyle('shape=mxgraph.aws4.lambda'))).toBe('rectangle');
	});
});

describe('wrapLabel', () => {
	it('keeps a short label on one line', () => {
		expect(wrapLabel('Hello', 200, 12)).toEqual(['Hello']);
	});

	it('honours explicit line breaks', () => {
		expect(wrapLabel('a\nb', 200, 12)).toEqual(['a', 'b']);
	});

	it('wraps Latin text on word boundaries', () => {
		const lines = wrapLabel('the quick brown fox jumps over the lazy dog', 60, 12);
		expect(lines.length).toBeGreaterThan(1);
		// No word may be split when a break was available between words.
		expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('the quick brown fox jumps over the lazy dog');
	});

	// Japanese has no spaces to break on, so a per-character break is the only
	// way to keep the label inside its box.
	it('breaks CJK text without spaces', () => {
		const lines = wrapLabel('这是一段很长的中文标签文本', 60, 12);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join('')).toBe('这是一段很长的中文标签文本');
	});

	// A single token wider than the box still has to be cut, or it runs past the
	// shape entirely.
	it('splits a single over-long token', () => {
		const lines = wrapLabel('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 40, 12);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join('')).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
	});

	it('returns nothing for an empty label', () => {
		expect(wrapLabel('', 100, 12)).toEqual([]);
	});
});

describe('renderDiagramSvg', () => {
	it('emits an svg with a viewBox covering the content', () => {
		const svg = render(box('value="Box"'));
		expect(svg).toMatch(/^<svg /);
		expect(svg).toContain('viewBox=');
		expect(svg).toContain('</svg>');
	});

	it('draws a rectangle with its label', () => {
		const svg = render(box('value="Hello"'));
		expect(svg).toContain('<rect');
		expect(svg).toContain('Hello');
	});

	it('draws an ellipse for an ellipse style', () => {
		const svg = render(box('style="ellipse" value="E"'));
		expect(svg).toContain('<ellipse');
	});

	it('draws a polygon for a rhombus', () => {
		const svg = render(box('style="rhombus" value="D"'));
		expect(svg).toContain('<polygon');
	});

	it('applies the document fill and stroke colours', () => {
		const svg = render(box('style="fillColor=#ffcc00;strokeColor=#333333"'));
		expect(svg).toContain('fill="#ffcc00"');
		expect(svg).toContain('stroke="#333333"');
	});

	it('uses the theme colours when the document specifies none', () => {
		expect(render(box('value="x"'), DARK_THEME)).toContain(DARK_THEME.fill);
		expect(render(box('value="x"'), LIGHT_THEME)).toContain(LIGHT_THEME.fill);
	});

	// A label is document text; it must never become markup in the webview.
	// draw.io labels are HTML, so a <script> tag in one is stripped as markup
	// rather than shown — what matters is that it cannot survive into the SVG.
	it('never lets a script tag through from a label', () => {
		const svg = render(box('value="&lt;script&gt;alert(1)&lt;/script&gt;"'));
		expect(svg).not.toContain('<script');
		expect(svg).not.toContain('</script');
	});

	// A label written as *text* (entity-escaped twice, so it survives HTML
	// stripping) must be escaped on the way into the SVG, not emitted raw.
	it('escapes angle brackets that reach the SVG as text', () => {
		const svg = render(box('value="&amp;lt;b&amp;gt;"'));
		expect(svg).toContain('&lt;b&gt;');
		expect(svg).not.toMatch(/<tspan[^>]*><b>/);
	});

	it('escapes a label containing a quote', () => {
		const svg = render(box('value="say &quot;hi&quot;"'));
		expect(svg).not.toMatch(/<tspan[^>]*say "hi"/);
		expect(svg).toContain('&quot;');
	});

	it('draws an edge as a path with an arrowhead marker', () => {
		const svg = render(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="50" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="300" y="0" width="100" height="50" as="geometry"/></mxCell>
			<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry as="geometry"/></mxCell>`,
		);
		expect(svg).toContain('<path');
		expect(svg).toContain('<marker');
		expect(svg).toContain('marker-end=');
	});

	it('omits the arrowhead when endArrow=none', () => {
		const svg = render(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="50" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="300" y="0" width="100" height="50" as="geometry"/></mxCell>
			<mxCell id="e" style="endArrow=none" edge="1" parent="1" source="a" target="b"><mxGeometry as="geometry"/></mxCell>`,
		);
		expect(svg).not.toContain('marker-end=');
	});

	// Endpoints resolved from source/target are centres; an untrimmed arrow ends
	// under the target box and its head is never seen.
	it('stops an edge at the target boundary, not its centre', () => {
		const svg = render(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="100" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="300" y="0" width="100" height="100" as="geometry"/></mxCell>
			<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry as="geometry"/></mxCell>`,
		);
		// Match the connector, not the arrowhead's own <path> inside <defs> — that
		// one comes first in the markup and would otherwise be measured instead.
		const path = /<path d="M ([\d.-]+) ([\d.-]+) L ([\d.-]+) [\d.-]+" fill="none"/.exec(svg);
		expect(path).not.toBeNull();
		// b's centre is x=350; the line must stop at its left edge, x=300.
		expect(Number(path![3])).toBeCloseTo(300, 0);
		// and start at a's right edge, x=100, not its centre x=50.
		expect(Number(path![1])).toBeCloseTo(100, 0);
	});

	// SVG ids are global to the whole page: two diagrams sharing a marker id
	// means the second one's arrowheads resolve to the first one's definition.
	it('scopes the arrowhead marker id per diagram', () => {
		const cells = `<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="100" y="0" width="10" height="10" as="geometry"/></mxCell>
			<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry as="geometry"/></mxCell>`;
		const first = render(cells, LIGHT_THEME, 'one');
		const second = render(cells, LIGHT_THEME, 'two');
		const idOf = (svg: string) => /<marker id="([^"]+)"/.exec(svg)![1];
		expect(idOf(first)).not.toBe(idOf(second));
	});

	it('renders an empty diagram without throwing', () => {
		expect(() => render('')).not.toThrow();
		expect(render('')).toContain('<svg');
	});

	it('draws no outline for a text-only shape', () => {
		const svg = render(box('style="text;html=1" value="just text"'));
		expect(svg).not.toContain('<rect');
		expect(svg).toContain('just text');
	});

	it('puts a container label at the top, not the middle', () => {
		const svg = render(box('style="swimlane" value="Lane"'));
		const y = /<tspan[^>]*y="([\d.]+)"/.exec(svg);
		expect(y).not.toBeNull();
		// The box spans y=0..50; a header label sits well above the midpoint.
		expect(Number(y![1])).toBeLessThan(25);
	});

	it('applies a dashed stroke', () => {
		expect(render(box('style="dashed=1"'))).toContain('stroke-dasharray');
	});

	it('renders bold from the fontStyle bitmask', () => {
		expect(render(box('style="fontStyle=1" value="B"'))).toContain('font-weight="bold"');
		expect(render(box('style="fontStyle=2" value="I"'))).toContain('font-style="italic"');
	});
});

describe('label contrast', () => {
	it('measures luminance with the sRGB coefficients', () => {
		expect(colorLuminance('#ffffff')).toBeCloseTo(1, 3);
		expect(colorLuminance('#000000')).toBeCloseTo(0, 3);
		// Green must read as far lighter than blue at equal channel value; a plain
		// average would call them identical and mis-pick the text colour.
		expect(colorLuminance('#00ff00')!).toBeGreaterThan(colorLuminance('#0000ff')!);
	});

	it('expands 3-digit hex', () => {
		expect(colorLuminance('#fff')).toBeCloseTo(colorLuminance('#ffffff')!, 6);
	});

	it('returns null for a value it cannot measure', () => {
		expect(colorLuminance('none')).toBeNull();
		expect(colorLuminance('red')).toBeNull();
	});

	it('picks dark text on a light fill and light text on a dark one', () => {
		expect(labelColorFor('#dae8fc', DARK_THEME)).toBe('#1f2430');
		expect(labelColorFor('#1a1a2e', LIGHT_THEME)).toBe('#f5f7fa');
	});

	it('falls back to the theme when there is no fill to measure', () => {
		expect(labelColorFor(undefined, DARK_THEME)).toBe(DARK_THEME.text);
		expect(labelColorFor('none', DARK_THEME)).toBe(DARK_THEME.text);
	});

	// The bug this guards: a document that sets a pale fillColor but no fontColor
	// rendered its label in the dark theme's near-white text, leaving it
	// effectively invisible on the pale box.
	it('keeps a label readable on a pale fill in dark mode', () => {
		const svg = render(box('style="fillColor=#dae8fc" value="Web"'), DARK_THEME);
		expect(svg).toContain('fill="#1f2430"');
		expect(svg).not.toContain(`fill="${DARK_THEME.text}"`);
	});

	// An explicit fontColor is the author's decision and must win regardless.
	it('always honours an explicit fontColor', () => {
		const svg = render(box('style="fillColor=#ffffff;fontColor=#ff0000" value="x"'), DARK_THEME);
		expect(svg).toContain('fill="#ff0000"');
	});

	// A shape with no fill of its own sits on the editor background, so there the
	// theme's own text colour is the correct choice.
	it('uses the theme colour for an unfilled shape', () => {
		const svg = render(box('style="fillColor=none" value="x"'), DARK_THEME);
		expect(svg).toContain(`fill="${DARK_THEME.text}"`);
	});
});

describe('AWS-style diagrams', () => {
	const awsIcon = (extra: string) =>
		`<mxCell id="a" ${extra} vertex="1" parent="1"><mxGeometry x="0" y="0" width="60" height="60" as="geometry"/></mxCell>`;

	it('reports contrast only when luminance differs enough', () => {
		expect(hasContrast('#000000', '#ffffff')).toBe(true);
		expect(hasContrast('#232f3e', '#2b3140')).toBe(false);
		// An unmeasurable colour keeps the author's choice rather than guessing.
		expect(hasContrast('red', '#ffffff')).toBe(true);
	});

	// The AWS shape library hard-codes near-black captions, which vanish on a dark
	// canvas. A label drawn *onto the page* — an unfilled frame's own title — is a
	// case where the backdrop is known, so an unreadable colour is replaced.
	it('overrides an unreadable authored colour on the page', () => {
		const svg = render(
			`<mxCell id="g" style="shape=mxgraph.aws4.group;fillColor=none;verticalAlign=top;fontColor=#232F3E" value="AWS Cloud" vertex="1" parent="1">
				<mxGeometry x="0" y="0" width="600" height="400" as="geometry"/>
			</mxCell>`,
			DARK_THEME,
		);
		expect(svg).not.toContain('fill="#232F3E"');
		expect(svg).toContain(`fill="${DARK_THEME.text}"`);
	});

	// A caption below an icon is drawn outside its shape and typically lands on an
	// enclosing subnet's pale fill, not on the page. Overriding it there produced
	// light text on pale green — worse than the colour the author chose — so the
	// authored colour is deliberately left alone when the backdrop is unknown.
	it('keeps an authored colour for a caption drawn outside its shape', () => {
		const svg = render(
			awsIcon('style="shape=mxgraph.aws4.users;verticalLabelPosition=bottom;fontColor=#232F3E" value="Users"'),
			DARK_THEME,
		);
		expect(svg).toContain('fill="#232F3E"');
	});

	// On a filled shape the fill travels with the label, so the author's colour
	// is still the right one and must not be second-guessed.
	it('keeps an authored colour on a filled shape', () => {
		const svg = render(awsIcon('style="fillColor=#ED7100;fontColor=#232F3E" value="EC2"'), DARK_THEME);
		expect(svg).toContain('fill="#232F3E"');
	});

	// An AWS group frame is a container: centring its title paints it over
	// everything the frame encloses.
	it('puts an AWS group frame title in its header', () => {
		const svg = render(
			`<mxCell id="g" style="shape=mxgraph.aws4.group;fillColor=none;verticalAlign=top" value="AWS Cloud" vertex="1" parent="1">
				<mxGeometry x="0" y="0" width="600" height="400" as="geometry"/>
			</mxCell>`,
		);
		const y = Number(/<tspan[^>]*y="([\d.]+)"/.exec(svg)![1]);
		expect(y).toBeLessThan(40); // near the top, not at the 200 midpoint
	});

	// `fillColor=none` is how every group frame declares itself transparent;
	// painting it with the theme fill hides whatever sits behind it.
	it('keeps a fillColor=none frame transparent', () => {
		const svg = render(
			`<mxCell id="g" style="shape=mxgraph.aws4.group;fillColor=none" value="" vertex="1" parent="1">
				<mxGeometry x="0" y="0" width="600" height="400" as="geometry"/>
			</mxCell>`,
		);
		expect(svg).toContain('fill="none"');
		expect(svg).not.toContain(`fill="${LIGHT_THEME.fill}"`);
	});

	// A resource icon's caption goes below the tile; drawn inside, a dark caption
	// lands on the icon's dark fill and disappears.
	it('draws a bottom-positioned caption below the shape', () => {
		const svg = render(awsIcon('style="verticalLabelPosition=bottom;fillColor=#2E27AD" value="RDS"'));
		const y = Number(/<tspan[^>]*y="([\d.]+)"/.exec(svg)![1]);
		expect(y).toBeGreaterThan(60); // the shape ends at y=60
	});

	// Bounds must grow for a caption drawn outside the shape, or the bottom row
	// of an AWS diagram is clipped at the diagram edge.
	it('extends the viewBox to cover a caption below the shape', () => {
		const svg = render(awsIcon('style="verticalLabelPosition=bottom" value="RDS"'));
		const vb = /viewBox="([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/.exec(svg)!;
		const top = Number(vb[2]);
		const height = Number(vb[4]);
		expect(top + height).toBeGreaterThan(78); // shape bottom (60) + caption room
	});

	it('renders a nested VPC/subnet structure without throwing', () => {
		const svg = render(
			`<mxCell id="cloud" style="shape=mxgraph.aws4.group;fillColor=none;verticalAlign=top" value="AWS Cloud" vertex="1" parent="1">
				<mxGeometry x="0" y="0" width="600" height="400" as="geometry"/></mxCell>
			<mxCell id="vpc" style="shape=mxgraph.aws4.group;fillColor=none;verticalAlign=top" value="VPC" vertex="1" parent="cloud">
				<mxGeometry x="40" y="40" width="500" height="320" as="geometry"/></mxCell>
			<mxCell id="sub" style="fillColor=#E9F3E6;strokeColor=#248814;verticalAlign=top" value="Public subnet" vertex="1" parent="vpc">
				<mxGeometry x="30" y="40" width="200" height="240" as="geometry"/></mxCell>
			<mxCell id="ec2" style="fillColor=#ED7100;verticalLabelPosition=bottom" value="EC2" vertex="1" parent="sub">
				<mxGeometry x="30" y="40" width="60" height="60" as="geometry"/></mxCell>`,
		);
		expect(svg).toContain('AWS Cloud');
		expect(svg).toContain('VPC');
		expect(svg).toContain('EC2');
		// The deepest child must land at the sum of its ancestors' offsets.
		expect(svg).toContain('x="100"'); // 0 + 40 + 30 + 30
	});
});

describe('orthogonal edge routing', () => {
	it('recognises draw.io orthogonal edge styles', () => {
		expect(isOrthogonalEdge(parseStyle('edgeStyle=orthogonalEdgeStyle'))).toBe(true);
		expect(isOrthogonalEdge(parseStyle('edgeStyle=elbowEdgeStyle'))).toBe(true);
		expect(isOrthogonalEdge(parseStyle('elbow=horizontal'))).toBe(true);
	});

	// An edge that explicitly asks for no routing is a deliberate straight line.
	it('leaves an explicit straight edge alone', () => {
		expect(isOrthogonalEdge(parseStyle('edgeStyle=none'))).toBe(false);
		expect(isOrthogonalEdge(parseStyle('html=1'))).toBe(false);
	});

	// Two shapes already on an axis need no elbow; adding one would produce a
	// pointless dog-leg where draw.io draws a plain straight line.
	it('returns no elbows when the shapes already line up', () => {
		expect(routeOrthogonal({ x: 0, y: 50 }, { x: 300, y: 50 })).toEqual([]);
		expect(routeOrthogonal({ x: 50, y: 0 }, { x: 50, y: 300 })).toEqual([]);
	});

	it('turns on x first for shapes placed side by side', () => {
		const pts = routeOrthogonal({ x: 0, y: 0 }, { x: 400, y: 100 });
		expect(pts).toEqual([
			{ x: 200, y: 0 },
			{ x: 200, y: 100 },
		]);
	});

	it('turns on y first for shapes stacked vertically', () => {
		const pts = routeOrthogonal({ x: 0, y: 0 }, { x: 100, y: 400 });
		expect(pts).toEqual([
			{ x: 0, y: 200 },
			{ x: 100, y: 200 },
		]);
	});

	// Every produced segment must be axis-aligned — that is the whole point.
	it('produces only horizontal and vertical segments', () => {
		const from = { x: 0, y: 0 };
		const to = { x: 340, y: 220 };
		const pts = [from, ...routeOrthogonal(from, to), to];
		for (let i = 1; i < pts.length; i++) {
			const horizontal = Math.abs(pts[i].y - pts[i - 1].y) < 1e-6;
			const vertical = Math.abs(pts[i].x - pts[i - 1].x) < 1e-6;
			expect(horizontal || vertical).toBe(true);
		}
	});

	it('routes a default-styled edge through elbows in the rendered svg', () => {
		const svg = render(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="260" y="180" width="120" height="60" as="geometry"/></mxCell>
			<mxCell id="e" style="edgeStyle=orthogonalEdgeStyle" edge="1" parent="1" source="a" target="b"><mxGeometry as="geometry"/></mxCell>`,
		);
		const d = /<path d="([^"]+)" fill="none"/.exec(svg)![1];
		// M + three L commands: two elbows between the trimmed endpoints.
		expect(d.match(/L/g)?.length).toBe(3);
	});

	// Author-placed waypoints describe a route the app already computed; they must
	// win over anything derived here.
	it('keeps author waypoints instead of routing', () => {
		const svg = render(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="60" height="60" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="300" y="300" width="60" height="60" as="geometry"/></mxCell>
			<mxCell id="e" style="edgeStyle=orthogonalEdgeStyle" edge="1" parent="1" source="a" target="b">
				<mxGeometry as="geometry"><Array as="points"><mxPoint x="30" y="330"/></Array></mxGeometry>
			</mxCell>`,
		);
		expect(/<path d="[^"]*L 30 330/.test(svg)).toBe(true);
	});

	// The boxes are found by id now; two shapes sharing a centre used to make the
	// old centre-matching lookup pick whichever came first.
	it('trims against the right box when two shapes share a centre', () => {
		const svg = render(
			`<mxCell id="big" style="fillColor=none" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="400" as="geometry"/></mxCell>
			<mxCell id="small" vertex="1" parent="1"><mxGeometry x="180" y="180" width="40" height="40" as="geometry"/></mxCell>
			<mxCell id="far" vertex="1" parent="1"><mxGeometry x="600" y="180" width="40" height="40" as="geometry"/></mxCell>
			<mxCell id="e" style="edgeStyle=none" edge="1" parent="1" source="small" target="far"><mxGeometry as="geometry"/></mxCell>`,
		);
		// Leaving `small` (centre x=200, half-width 20) the line starts at x=220,
		// not at the enclosing box's edge (x=400).
		// Anchored on `fill="none"` so this reads the connector, not the arrowhead
		// marker's own path inside <defs>, which comes first in the markup.
		const d = /<path d="M ([\d.-]+) [\d.-]+[^"]*" fill="none"/.exec(svg)![1];
		expect(Number(d)).toBeCloseTo(220, 0);
	});
});

describe('routing around obstacles', () => {
	// A long connector's midpoint elbow very often lands inside some other box. In
	// the blue/green sample a pod's line to the database cut straight through the
	// whole opposite environment before this.
	it('shifts the corridor off a blocking shape', () => {
		const from = { x: 100, y: 0 };
		const to = { x: 100, y: 400 };
		// Directly between them, straddling the natural midpoint at y=200.
		const wall = { x: 0, y: 170, width: 300, height: 60 };
		const straight = routeOrthogonal(from, { x: 300, y: 400 }, undefined, undefined, []);
		const avoided = routeOrthogonal(from, { x: 300, y: 400 }, undefined, undefined, [wall]);
		expect(avoided).not.toEqual(straight);
		// Whatever corridor it picks must clear the wall (plus its margin).
		for (const p of avoided) {
			if (p.y > 0 && p.y < 400) expect(p.y < 160 || p.y > 240).toBe(true);
		}
	});

	it('keeps the natural route when nothing is in the way', () => {
		const from = { x: 0, y: 0 };
		const to = { x: 400, y: 100 };
		const far = { x: 0, y: 900, width: 100, height: 50 };
		expect(routeOrthogonal(from, to, undefined, undefined, [far])).toEqual(
			routeOrthogonal(from, to, undefined, undefined, []),
		);
	});

	// Boxing the route in on every side must not throw or fling the line away —
	// draw.io's own position is a better answer than an arbitrary detour.
	it('falls back to the natural route when every corridor is blocked', () => {
		const from = { x: 0, y: 0 };
		const to = { x: 400, y: 400 };
		const everywhere = { x: -1000, y: -1000, width: 4000, height: 4000 };
		const pts = routeOrthogonal(from, to, undefined, undefined, [everywhere]);
		expect(pts).toHaveLength(2);
		expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
	});

	// A frame exists to be crossed; treating VPC/subnet/cluster boxes as obstacles
	// would leave every line entering one with nowhere to turn.
	it('does not treat container frames as obstacles', () => {
		const svg = render(
			`<mxCell id="frame" style="shape=mxgraph.aws4.group;fillColor=none;verticalAlign=top" value="VPC" vertex="1" parent="1">
				<mxGeometry x="0" y="0" width="600" height="400" as="geometry"/></mxCell>
			<mxCell id="a" vertex="1" parent="1"><mxGeometry x="40" y="40" width="60" height="40" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="400" y="300" width="60" height="40" as="geometry"/></mxCell>
			<mxCell id="e" style="edgeStyle=orthogonalEdgeStyle" edge="1" parent="1" source="a" target="b"><mxGeometry as="geometry"/></mxCell>`,
		);
		// Two elbows, i.e. the ordinary route — the frame did not push it around.
		const d = /<path d="([^"]+)" fill="none"/.exec(svg)![1];
		expect(d.match(/L/g)?.length).toBe(3);
	});
});

describe('label fitting', () => {
	it('keeps the requested size when the text already fits', () => {
		const r = fitLabel('short', 200, 100, 12);
		expect(r.fontSize).toBe(12);
		expect(r.lines).toEqual(['short']);
	});

	// The defect this prevents: a label longer than its box was drawn past the
	// border, over whatever was next to it — damaging other shapes' readability.
	it('shrinks the font until the block fits the height', () => {
		const tall = fitLabel('这是一个放入狭窄方框中的很长标签文本'.repeat(2), 90, 50, 12);
		expect(tall.fontSize).toBeLessThan(12);
		expect(tall.lines.length * tall.fontSize * 1.25).toBeLessThanOrEqual(50);
	});

	// Better a tiny label than a clipped one, and better either than dropping the
	// text and hiding what the diagram says.
	it('stops shrinking at the floor and keeps the text', () => {
		const r = fitLabel('这是一段很长的字符串'.repeat(20), 40, 12, 12);
		expect(r.fontSize).toBeGreaterThanOrEqual(6);
		expect(r.lines.join('')).toContain('这是一段很长');
	});

	it('imposes no limit when no height is given', () => {
		expect(fitLabel('a b c d e f', 40, undefined, 12).fontSize).toBe(12);
	});

	it('renders a long label inside its shape', () => {
		const svg = render(box('style="whiteSpace=wrap" value="这是一个放入狭窄方框中的很长标签文本这是一个放入狭窄方框中的很长标签文本"'));
		const size = Number(/<text[^>]*font-size="([\d.]+)"/.exec(svg)![1]);
		expect(size).toBeLessThan(12);
		// Every baseline must stay within the shape (y = 0..50).
		for (const m of svg.matchAll(/<tspan[^>]*y="([\d.]+)"/g)) {
			expect(Number(m[1])).toBeGreaterThan(0);
			expect(Number(m[1])).toBeLessThan(52);
		}
	});
});

describe('text alignment', () => {
	// draw.io uses left-aligned text for anything list-like; centring those turns
	// an orderly column into a ragged block.
	it('honours align=left', () => {
		const svg = render(box('style="align=left" value="left"'));
		expect(svg).toContain('text-anchor="start"');
	});

	it('honours align=right', () => {
		expect(render(box('style="align=right" value="r"'))).toContain('text-anchor="end"');
	});

	it('centres by default', () => {
		expect(render(box('value="c"'))).toContain('text-anchor="middle"');
	});
});

describe('fixed connection points', () => {
	const geom = { x: 100, y: 100, width: 80, height: 40 };

	it('resolves a fraction into an absolute point', () => {
		// exitX=1, exitY=0.5 → middle of the right edge.
		expect(fixedConnectionPoint(parseStyle('exitX=1;exitY=0.5'), geom, 'exit')).toEqual({ x: 180, y: 120 });
		expect(fixedConnectionPoint(parseStyle('entryX=0;entryY=0'), geom, 'entry')).toEqual({ x: 100, y: 100 });
	});

	it('returns null when the edge does not pin that end', () => {
		expect(fixedConnectionPoint(parseStyle('html=1'), geom, 'exit')).toBeNull();
		// Both coordinates are required; one alone is not a point.
		expect(fixedConnectionPoint(parseStyle('exitX=1'), geom, 'exit')).toBeNull();
	});

	it('returns null without a box to resolve against', () => {
		expect(fixedConnectionPoint(parseStyle('exitX=1;exitY=0.5'), undefined, 'exit')).toBeNull();
	});

	// The author put the line on that spot deliberately; trimming it back to the
	// outline afterwards would move it off the side they chose.
	it('starts and ends exactly on the pinned points', () => {
		const svg = render(
			`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="50" as="geometry"/></mxCell>
			<mxCell id="b" vertex="1" parent="1"><mxGeometry x="300" y="200" width="80" height="50" as="geometry"/></mxCell>
			<mxCell id="e" style="edgeStyle=orthogonalEdgeStyle;exitX=1;exitY=0.5;entryX=0;entryY=0.5" edge="1" parent="1" source="a" target="b">
				<mxGeometry as="geometry"/></mxCell>`,
		);
		const d = /<path d="M ([\d.-]+) ([\d.-]+)[^"]*L ([\d.-]+) ([\d.-]+)" fill="none"/.exec(svg);
		expect(d).not.toBeNull();
		expect(Number(d![1])).toBeCloseTo(80, 0); // a's right edge
		expect(Number(d![2])).toBeCloseTo(25, 0); // a's vertical middle
	});
});

describe('start arrows', () => {
	const pair = (edgeStyle: string) =>
		`<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="60" height="40" as="geometry"/></mxCell>
		<mxCell id="b" vertex="1" parent="1"><mxGeometry x="300" y="0" width="60" height="40" as="geometry"/></mxCell>
		<mxCell id="e" style="${edgeStyle}" edge="1" parent="1" source="a" target="b"><mxGeometry as="geometry"/></mxCell>`;

	// A two-way relationship drawn with one head says something the diagram does
	// not — this is a correctness issue, not a cosmetic one.
	it('draws both heads for a bidirectional edge', () => {
		const svg = render(pair('startArrow=classic;endArrow=classic'));
		expect(svg).toContain('marker-start=');
		expect(svg).toContain('marker-end=');
	});

	it('draws no start head by default', () => {
		const svg = render(pair('endArrow=classic'));
		expect(svg).not.toContain('marker-start=');
		expect(svg).toContain('marker-end=');
	});

	it('honours startArrow=none', () => {
		expect(render(pair('startArrow=none'))).not.toContain('marker-start=');
	});

	// A source-only arrow is how a "reply"/"reads from" direction is drawn.
	it('supports a start head with no end head', () => {
		const svg = render(pair('startArrow=classic;endArrow=none'));
		expect(svg).toContain('marker-start=');
		expect(svg).not.toContain('marker-end=');
	});
});

describe('AWS architecture symbols', () => {
	// A stand-in table: the real one is generated at build time, and these tests
	// are about how a shape is placed and coloured, not about its artwork.
	const SHAPES: Record<string, { w: number; h: number; d: string }> = {
		ec2: { w: 56, h: 56, d: 'M 0 0 L 56 0 L 56 56 Z' },
		group_vpc2: { w: 400, h: 400, d: 'M 0 0 L 400 400 Z' },
	};
	const lookup = (k: string) => SHAPES[k] ?? null;

	const withLookup = (cells: string, theme = LIGHT_THEME) => {
		const xml = `<mxfile><diagram name="P"><mxGraphModel><root>
			<mxCell id="0"/><mxCell id="1" parent="0"/>${cells}
		</root></mxGraphModel></diagram></mxfile>`;
		return renderDiagramSvg(buildDiagram(parseTestXml(xml)), theme, 'u', 0, lookup);
	};

	const tile = (extra: string) =>
		`<mxCell id="a" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.ec2;fillColor=#ED7100;strokeColor=#ffffff;${extra}" vertex="1" parent="1">
			<mxGeometry x="0" y="0" width="60" height="60" as="geometry"/></mxCell>`;

	it('draws the service symbol on a resource tile', () => {
		const svg = withLookup(tile(''));
		expect(svg).toContain(SHAPES.ec2.d);
		expect(svg).toContain('viewBox="0 0 56 56"');
	});

	// The path data is redistributed under terms that forbid derivatives, so the
	// stored geometry must reach the output untouched — scaling happens through
	// the viewBox, never by rewriting coordinates.
	it('emits the path data verbatim', () => {
		const svg = withLookup(tile(''));
		expect(svg).toContain(`d="${SHAPES.ec2.d}"`);
	});

	// The stencils carry no colour; it must come from the user's own diagram.
	it('colours the symbol from the diagram, not from the theme', () => {
		const light = withLookup(tile(''), LIGHT_THEME);
		const dark = withLookup(tile(''), DARK_THEME);
		expect(light).toContain('<path d="M 0 0 L 56 0 L 56 56 Z" fill="#ffffff"/>');
		// Identical in both themes: nothing here adapts the symbol's colour.
		expect(dark).toContain('<path d="M 0 0 L 56 0 L 56 56 Z" fill="#ffffff"/>');
	});

	// The bug this guards: a frame's badge was scaled to the whole frame, painting
	// a VPC mark across the entire diagram and burying its contents.
	it('draws a group badge small, in the frame corner', () => {
		const svg = withLookup(
			`<mxCell id="g" style="shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc2;fillColor=none;strokeColor=#248814;verticalAlign=top" value="VPC" vertex="1" parent="1">
				<mxGeometry x="0" y="0" width="960" height="800" as="geometry"/></mxCell>`,
		);
		const m = /<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg);
		expect(m).not.toBeNull();
		expect(Number(m![3])).toBeLessThan(40); // a badge, not an 960-wide backdrop
		expect(Number(m![4])).toBeLessThan(40);
		expect(Number(m![1])).toBeLessThan(20); // near the left edge
	});

	// A resource tile names both the generic tile (`shape=`) and the service
	// (`resIcon=`); reading `shape` would redraw the tile instead of the service.
	it('prefers resIcon over the generic tile shape', () => {
		const svg = withLookup(tile(''));
		// The generic `resourceIcon` shape is not in the table, so a wrong lookup
		// would emit nothing at all.
		expect(svg).toContain('viewBox="0 0 56 56"');
	});

	it('falls back to the plain tile when the shape is unknown', () => {
		const svg = withLookup(
			`<mxCell id="a" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.not_a_real_service;fillColor=#ED7100" vertex="1" parent="1">
				<mxGeometry x="0" y="0" width="60" height="60" as="geometry"/></mxCell>`,
		);
		expect(svg).toContain('fill="#ED7100"'); // the tile still renders
		expect(svg).not.toContain('viewBox="0 0 56 56"');
	});

	// Without a table (it loads asynchronously) the diagram must still render.
	it('renders without a lookup at all', () => {
		const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${tile('')}</root></mxGraphModel>`;
		const svg = renderDiagramSvg(buildDiagram(parseTestXml(xml)), LIGHT_THEME, 'u');
		expect(svg).toContain('fill="#ED7100"');
		expect(svg).not.toContain('<svg x=');
	});

	it('ignores shapes from other stencil libraries', () => {
		const svg = withLookup(
			`<mxCell id="a" style="shape=mxgraph.azure.virtual_machine;fillColor=#0078D4" vertex="1" parent="1">
				<mxGeometry x="0" y="0" width="60" height="60" as="geometry"/></mxCell>`,
		);
		expect(svg).not.toContain('<svg x=');
	});
});
