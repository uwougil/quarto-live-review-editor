/**
 * Parser for draw.io / diagrams.net documents.
 *
 * A `.drawio` file is an `<mxfile>` wrapping one `<diagram>` per page, and each
 * page holds an `<mxGraphModel>` whose `<root>` is a flat list of `<mxCell>`
 * elements. "Flat" is the important part: nesting, z-order and edge endpoints
 * are all expressed as *id references* between siblings (`parent`, `source`,
 * `target`), not as XML structure, so the tree has to be reassembled here
 * before anything can be drawn.
 *
 * Two further wrinkles this module absorbs, both of which produce a blank
 * diagram rather than an error if ignored:
 *
 *  - A `<diagram>`'s text is often not XML at all but a compressed payload
 *    (deflate + base64, historically URI-encoded on top). `decodeDiagramBody`
 *    detects and rejects that case explicitly so the caller can say so, rather
 *    than the parser silently finding no cells in a base64 blob.
 *  - Geometry is relative for a child of a non-root cell: a shape inside a
 *    container records coordinates measured from the container's origin.
 *    `flattenCells` resolves those to absolute page coordinates.
 *
 * The output is a plain, renderer-agnostic model (`DrawioDiagram`) rather than
 * SVG, so the shape of the document can be unit-tested in Node without a DOM.
 */

/** A `style="key=value;flag;"` string parsed into a lookup. */
export type DrawioStyle = Map<string, string>;

export interface DrawioGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A node: a box, ellipse, diamond, … — anything that is not an edge. */
export interface DrawioVertex {
	kind: 'vertex';
	id: string;
	label: string;
	geometry: DrawioGeometry;
	style: DrawioStyle;
}

/** A connector between two vertices, or between free-floating points. */
export interface DrawioEdge {
	kind: 'edge';
	id: string;
	label: string;
	/** Absolute endpoints, resolved from `source`/`target` cells or fixed points. */
	from: { x: number; y: number } | null;
	to: { x: number; y: number } | null;
	/**
	 * Ids of the shapes this edge connects, when it connects any.
	 *
	 * The renderer needs the actual boxes — to trim the line at their outline and
	 * to route around them — and matching them back by comparing centre
	 * coordinates (which is what it did before these were carried) misidentifies
	 * the box whenever two shapes happen to share a centre, and finds nothing at
	 * all once a coordinate is a hair off.
	 */
	sourceId: string | null;
	targetId: string | null;
	/** Intermediate absolute waypoints declared via `<mxPoint as="points">`. */
	waypoints: Array<{ x: number; y: number }>;
	style: DrawioStyle;
}

export type DrawioShape = DrawioVertex | DrawioEdge;

export interface DrawioPage {
	name: string;
	shapes: DrawioShape[];
	/** Bounding box of everything on the page, already padded for display. */
	bounds: DrawioGeometry;
}

export interface DrawioDiagram {
	pages: DrawioPage[];
}

/** Raised for input this module understands but deliberately cannot render. */
export class DrawioUnsupportedError extends Error {}

/** Padding left around the content's bounding box, in diagram units. */
const BOUNDS_PADDING = 12;

/**
 * Vertical room reserved per line of a caption drawn *below* its shape.
 *
 * Generous on purpose: the exact height depends on the font size and on how the
 * text wraps, neither of which is known here, and under-reserving clips the
 * caption while over-reserving only adds a little whitespace.
 */
const LABEL_BELOW_ALLOWANCE = 18;

/**
 * Splits a draw.io `style` attribute into key/value pairs.
 *
 * The first segment is frequently a bare shape name with no `=` (`ellipse;...`),
 * and boolean flags are written the same way, so a segment without `=` is
 * recorded as itself mapped to `'1'` — that lets callers test `style.has('ellipse')`
 * and `style.get('rounded') === '1'` through one uniform lookup.
 */
export function parseStyle(style: string | null | undefined): DrawioStyle {
	const result: DrawioStyle = new Map();
	if (!style) return result;
	for (const part of style.split(';')) {
		const segment = part.trim();
		if (!segment) continue;
		const eq = segment.indexOf('=');
		if (eq === -1) result.set(segment.toLowerCase(), '1');
		else result.set(segment.slice(0, eq).trim().toLowerCase(), segment.slice(eq + 1).trim());
	}
	return result;
}

/**
 * draw.io labels are HTML fragments (`<b>a</b><br>b`), not plain text.
 *
 * They are reduced to plain text with line breaks preserved: the renderer draws
 * labels as SVG `<text>`, which has no HTML support, and injecting the markup
 * into the page instead would be an XSS vector for a document the user merely
 * opened. Entities are decoded last so that a literal `&lt;b&gt;` in the source
 * stays visible text rather than becoming a tag on the next pass.
 */
export function labelToPlainText(html: string | null | undefined): string {
	if (!html) return '';
	const withBreaks = html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
		.replace(/<[^>]*>/g, '');
	return decodeEntities(withBreaks).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
		if (body.startsWith('#')) {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? match;
	});
}

function num(value: string | null | undefined, fallback = 0): number {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * Reports whether a `<diagram>`'s body is draw.io's compressed payload rather
 * than inline XML.
 *
 * Uncompressed pages start with an `<mxGraphModel>` element; the compressed form
 * is a single base64 run. Detecting it by *absence* of that element (rather than
 * by testing for base64 characters, which plenty of valid XML also contains)
 * keeps the check from misfiring on ordinary markup.
 */
export function isCompressedDiagramBody(body: string): boolean {
	const trimmed = body.trim();
	if (!trimmed) return false;
	if (/<\s*mxGraphModel[\s>]/i.test(trimmed)) return false;
	return !trimmed.startsWith('<');
}

/**
 * The sliver of the DOM this parser needs.
 *
 * The webview has `DOMParser` natively, but the unit tests run under plain Node
 * (see vitest.config.ts) where it does not exist. Depending on this interface
 * rather than on `Element` lets the same parsing logic be driven by a tiny
 * stand-in in tests and by the real DOM at runtime, without shipping a DOM
 * implementation to either.
 */
export interface XmlElement {
	readonly tagName: string;
	getAttribute(name: string): string | null;
	readonly childElements: readonly XmlElement[];
	readonly textContent: string;
}

/** Depth-first search for every descendant (and self) with the given tag name. */
function findAll(root: XmlElement, tagName: string): XmlElement[] {
	const wanted = tagName.toLowerCase();
	const found: XmlElement[] = [];
	const visit = (el: XmlElement) => {
		if (el.tagName.toLowerCase() === wanted) found.push(el);
		for (const child of el.childElements) visit(child);
	};
	visit(root);
	return found;
}

function findFirst(root: XmlElement, tagName: string): XmlElement | undefined {
	return findAll(root, tagName)[0];
}

/** Raw `<mxCell>` data, before parent geometry has been folded in. */
interface RawCell {
	id: string;
	parent: string | null;
	source: string | null;
	target: string | null;
	label: string;
	isVertex: boolean;
	isEdge: boolean;
	style: DrawioStyle;
	geometry: DrawioGeometry | null;
	/** `relative="1"` — the geometry is a fraction along the parent, not a size. */
	relative: boolean;
	waypoints: Array<{ x: number; y: number }>;
	sourcePoint: { x: number; y: number } | null;
	targetPoint: { x: number; y: number } | null;
}

/**
 * Reads one `<mxCell>`, including the geometry and points nested inside it.
 *
 * A cell's own `<mxGeometry>` may carry several `<mxPoint>` children
 * distinguished only by their `as` attribute (`sourcePoint`, `targetPoint`,
 * `offset`), plus an `<Array as="points">` of waypoints — so they are picked
 * apart by that attribute rather than by position.
 */
function readCell(el: XmlElement, labelOverride?: string): RawCell {
	const geometryEl = findFirst(el, 'mxGeometry');
	let geometry: DrawioGeometry | null = null;
	let sourcePoint: { x: number; y: number } | null = null;
	let targetPoint: { x: number; y: number } | null = null;
	const waypoints: Array<{ x: number; y: number }> = [];

	if (geometryEl) {
		geometry = {
			x: num(geometryEl.getAttribute('x')),
			y: num(geometryEl.getAttribute('y')),
			width: num(geometryEl.getAttribute('width')),
			height: num(geometryEl.getAttribute('height')),
		};
		for (const child of geometryEl.childElements) {
			const tag = child.tagName.toLowerCase();
			if (tag === 'mxpoint') {
				const as = child.getAttribute('as');
				const point = { x: num(child.getAttribute('x')), y: num(child.getAttribute('y')) };
				if (as === 'sourcePoint') sourcePoint = point;
				else if (as === 'targetPoint') targetPoint = point;
			} else if (tag === 'array' && child.getAttribute('as') === 'points') {
				for (const p of child.childElements) {
					if (p.tagName.toLowerCase() !== 'mxpoint') continue;
					waypoints.push({ x: num(p.getAttribute('x')), y: num(p.getAttribute('y')) });
				}
			}
		}
	}

	return {
		id: el.getAttribute('id') ?? '',
		parent: el.getAttribute('parent'),
		source: el.getAttribute('source'),
		target: el.getAttribute('target'),
		label: labelToPlainText(labelOverride ?? el.getAttribute('value')),
		isVertex: el.getAttribute('vertex') === '1',
		isEdge: el.getAttribute('edge') === '1',
		style: parseStyle(el.getAttribute('style')),
		geometry,
		relative: el.getAttribute('relative') === '1' || geometryEl?.getAttribute('relative') === '1',
		waypoints,
		sourcePoint,
		targetPoint,
	};
}

/**
 * Collects the cells of one `<root>`, including those wrapped in `<object>` /
 * `<UserObject>`.
 *
 * When a shape carries custom metadata, draw.io moves the `<mxCell>` inside an
 * `<object>` element that holds the id and the label instead — so a parser that
 * only looks at `<mxCell>` attributes loses both for exactly those shapes. The
 * wrapper's own `label`/`id` are therefore read and passed down.
 */
function collectCells(root: XmlElement): RawCell[] {
	const cells: RawCell[] = [];
	const visit = (el: XmlElement) => {
		const tag = el.tagName.toLowerCase();
		if (tag === 'object' || tag === 'userobject') {
			const inner = el.childElements.find((c) => c.tagName.toLowerCase() === 'mxcell');
			if (inner) {
				const cell = readCell(inner, el.getAttribute('label') ?? undefined);
				// The wrapper owns the identity; the inner <mxCell> usually has no id.
				const wrapperId = el.getAttribute('id');
				if (wrapperId) cell.id = wrapperId;
				cells.push(cell);
				return;
			}
		}
		if (tag === 'mxcell') {
			cells.push(readCell(el));
			return;
		}
		for (const child of el.childElements) visit(child);
	};
	visit(root);
	return cells;
}

/**
 * Resolves every cell's coordinates into one absolute page space.
 *
 * A cell's `<mxGeometry>` is measured from its *parent's* origin whenever that
 * parent is itself a vertex (a container/swimlane), so a shape drawn inside a
 * container reports coordinates like `x="20"` that mean nothing on their own.
 * Offsets are therefore accumulated down the parent chain. The chain is walked
 * iteratively with a `seen` set instead of recursing, because `parent` is a free
 * id reference: a malformed file can point a cell at its own descendant, and a
 * naive walk would loop forever on a document the user merely opened.
 *
 * Edges are resolved after vertices, since an edge's endpoints are usually the
 * *centres* of cells that must already have absolute positions.
 */
export function flattenCells(cells: readonly RawCell[]): DrawioShape[] {
	const byId = new Map<string, RawCell>();
	for (const cell of cells) if (cell.id) byId.set(cell.id, cell);

	/** Absolute top-left of a vertex, following its parent chain. */
	const absoluteOrigin = new Map<string, { x: number; y: number }>();
	const originOf = (cell: RawCell): { x: number; y: number } => {
		const cached = absoluteOrigin.get(cell.id);
		if (cached) return cached;
		let x = cell.geometry?.x ?? 0;
		let y = cell.geometry?.y ?? 0;
		const seen = new Set<string>([cell.id]);
		let parentId = cell.parent;
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = byId.get(parentId);
			// The two implicit root cells (id "0" and "1") are not shapes and
			// contribute no offset; a parent that is an edge doesn't either.
			if (!parent || !parent.isVertex || !parent.geometry) break;
			x += parent.geometry.x;
			y += parent.geometry.y;
			parentId = parent.parent;
		}
		const origin = { x, y };
		absoluteOrigin.set(cell.id, origin);
		return origin;
	};

	const vertices = new Map<string, DrawioVertex>();
	const shapes: DrawioShape[] = [];

	for (const cell of cells) {
		if (!cell.isVertex || !cell.geometry) continue;
		// A vertex with `relative="1"` is a label pinned along an edge, not a box
		// on the page: its geometry is a position *fraction*, so drawing it as a
		// rectangle would put a stray shape at the top-left corner.
		if (cell.relative) continue;
		const origin = originOf(cell);
		const vertex: DrawioVertex = {
			kind: 'vertex',
			id: cell.id,
			label: cell.label,
			geometry: { x: origin.x, y: origin.y, width: cell.geometry.width, height: cell.geometry.height },
			style: cell.style,
		};
		vertices.set(cell.id, vertex);
		shapes.push(vertex);
	}

	const centreOf = (id: string | null): { x: number; y: number } | null => {
		if (!id) return null;
		const vertex = vertices.get(id);
		if (!vertex) return null;
		return {
			x: vertex.geometry.x + vertex.geometry.width / 2,
			y: vertex.geometry.y + vertex.geometry.height / 2,
		};
	};

	for (const cell of cells) {
		if (!cell.isEdge) continue;
		// An edge attached to a shape wins over its own recorded endpoint: draw.io
		// keeps a stale `sourcePoint` from before the connection was made, and
		// honouring that would leave the line detached from the box it now joins.
		const from = centreOf(cell.source) ?? cell.sourcePoint;
		const to = centreOf(cell.target) ?? cell.targetPoint;
		if (!from && !to) continue; // nothing anchors this line; drawing it is guesswork
		shapes.push({
			kind: 'edge',
			id: cell.id,
			label: cell.label,
			from,
			to,
			// Only ids that resolved to a real vertex: a dangling reference would
			// otherwise send the renderer looking for a box that is not there.
			sourceId: cell.source && vertices.has(cell.source) ? cell.source : null,
			targetId: cell.target && vertices.has(cell.target) ? cell.target : null,
			waypoints: cell.waypoints,
			style: cell.style,
		});
	}

	return shapes;
}

/**
 * Bounding box of every shape, padded, in diagram coordinates.
 *
 * This becomes the SVG `viewBox`, so it must cover edge waypoints and loose
 * endpoints as well as boxes — a connector routed outside the shapes it joins
 * would otherwise be clipped away at the border.
 */
export function computeBounds(shapes: readonly DrawioShape[]): DrawioGeometry {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const include = (x: number, y: number) => {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	};

	for (const shape of shapes) {
		if (shape.kind === 'vertex') {
			include(shape.geometry.x, shape.geometry.y);
			include(shape.geometry.x + shape.geometry.width, shape.geometry.y + shape.geometry.height);
			// A caption placed below the shape (the AWS resource-icon convention,
			// `verticalLabelPosition=bottom`) is drawn outside the shape's own box,
			// so the bounds have to grow for it or the bottom row of labels is
			// clipped off at the diagram's edge.
			if (shape.label && shape.style.get('verticallabelposition') === 'bottom') {
				const lines = shape.label.split('\n').length;
				include(shape.geometry.x, shape.geometry.y + shape.geometry.height + LABEL_BELOW_ALLOWANCE * lines);
			}
		} else {
			if (shape.from) include(shape.from.x, shape.from.y);
			if (shape.to) include(shape.to.x, shape.to.y);
			for (const p of shape.waypoints) include(p.x, p.y);
		}
	}

	// An empty page still needs a usable viewBox; a zero-sized one renders nothing
	// at all and makes the failure look like a broken parser rather than an empty
	// diagram.
	if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 100, height: 60 };

	return {
		x: minX - BOUNDS_PADDING,
		y: minY - BOUNDS_PADDING,
		width: Math.max(1, maxX - minX + BOUNDS_PADDING * 2),
		height: Math.max(1, maxY - minY + BOUNDS_PADDING * 2),
	};
}

/**
 * Builds the diagram model from a parsed `<mxfile>` (or a bare `<mxGraphModel>`,
 * which is what a code fence usually contains).
 *
 * Throws `DrawioUnsupportedError` for a compressed document — that is a real
 * limitation worth telling the user about, and it is indistinguishable from a
 * corrupt file if it silently yields an empty diagram instead.
 */
/**
 * Whether an element can stand in for an `<mxGraphModel>`.
 *
 * A fence may hold just the `<root>` list of cells, with no model wrapper. That
 * is legitimate, but "no wrapper" must not become "anything goes": without this
 * check an arbitrary XML (or HTML) document parses as a diagram with zero cells
 * and renders as an empty box, hiding the fact that it holds no diagram at all.
 */
function isModelRoot(el: XmlElement): boolean {
	const tag = el.tagName.toLowerCase();
	if (tag === 'root' || tag === 'mxgraphmodel') return true;
	// Otherwise it must at least contain cells to be worth rendering.
	return findAll(el, 'mxCell').length > 0;
}

export function buildDiagram(root: XmlElement): DrawioDiagram {
	const diagramEls = findAll(root, 'diagram');
	// A fence holding a bare <mxGraphModel> has no <diagram> wrapper at all.
	const sources: Array<{ name: string; el: XmlElement | undefined; body: string }> =
		diagramEls.length > 0
			? diagramEls.map((el, i) => ({
					name: el.getAttribute('name') || `Page-${i + 1}`,
					el: findFirst(el, 'mxGraphModel'),
					body: el.textContent,
				}))
			: // A fence holding only `<root>...` (no <mxGraphModel> wrapper) is still a
				// diagram, so the root itself is accepted — but only when it actually
				// looks like one. Accepting any root unconditionally would make
				// unrelated XML parse as a valid, empty diagram and render blank
				// instead of reporting that there is no diagram in it.
				[
					{
						name: 'Page-1',
						el: findFirst(root, 'mxGraphModel') ?? (isModelRoot(root) ? root : undefined),
						body: root.textContent,
					},
				];

	const pages: DrawioPage[] = [];
	for (const source of sources) {
		if (!source.el) {
			if (isCompressedDiagramBody(source.body)) {
				throw new DrawioUnsupportedError(
					'不支持压缩的 draw.io 文件。请在 draw.io 中关闭“压缩 XML”后重新保存。',
				);
			}
			continue;
		}
		const modelRoot = findFirst(source.el, 'root') ?? source.el;
		const shapes = flattenCells(collectCells(modelRoot));
		pages.push({ name: source.name, shapes, bounds: computeBounds(shapes) });
	}

	if (pages.length === 0) throw new DrawioUnsupportedError('未找到 draw.io 图形。');
	return { pages };
}
