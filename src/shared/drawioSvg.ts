/**
 * Renders a parsed draw.io diagram (see drawio.ts) to an SVG string.
 *
 * Output is a *string* rather than DOM nodes so the whole renderer stays
 * testable under plain Node, and so the caller can hand it to `innerHTML` in one
 * assignment the way the Mermaid widget already does. Everything drawn from the
 * document — labels, colours, shape names — is escaped or validated here, since
 * the source is a file the user merely opened and must not be able to inject
 * markup or a `javascript:` URL into the webview.
 *
 * Fidelity is deliberately bounded: draw.io's full shape library runs to
 * thousands of stencils, so the basic vocabulary (rectangle, rounded rectangle,
 * ellipse, rhombus, triangle, cylinder, hexagon, note, plus connectors) is drawn
 * properly and anything else falls back to a labelled rectangle. That keeps the
 * structure of an unfamiliar diagram readable instead of dropping the shape.
 */
import type {
	DrawioDiagram,
	DrawioEdge,
	DrawioGeometry,
	DrawioPage,
	DrawioShape,
	DrawioStyle,
	DrawioVertex,
} from './drawio';

/** One AWS stencil: its native box and the SVG path data for its outline. */
export interface AwsShapeGeometry {
	w: number;
	h: number;
	d: string;
}

/**
 * Looks up an AWS architecture shape by its stencil key (`ec2`, `group_vpc2`).
 *
 * Passed in rather than imported so this module stays DOM-free and unit-testable
 * under Node: the table is fetched by the webview, which owns that plumbing.
 * Returning `null` — including while the table is still loading — makes the
 * caller fall back to the plain coloured tile.
 */
export type AwsShapeLookup = (key: string) => AwsShapeGeometry | null;

/** Colours used when the document does not specify its own. */
export interface DrawioTheme {
	stroke: string;
	fill: string;
	text: string;
}

export const LIGHT_THEME: DrawioTheme = { stroke: '#39435a', fill: '#ffffff', text: '#1f2430' };
export const DARK_THEME: DrawioTheme = { stroke: '#b8c1d4', fill: '#2b3140', text: '#e6e9f0' };

// Single-quoted inside the family list on purpose: this string is interpolated
// into a double-quoted SVG attribute, and a double-quoted family name would
// close that attribute early and corrupt every <text> element in the diagram.
const FONT_FAMILY =
	"Helvetica, Arial, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, sans-serif";
const DEFAULT_FONT_SIZE = 12;
/** Ratio of font size to line box height, matching draw.io's own label spacing. */
const LINE_HEIGHT = 1.25;

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Passes through only colour values that are safe to drop into a `fill` or
 * `stroke` attribute.
 *
 * draw.io writes `#rrggbb` or a CSS colour name, and `none`. Anything else — a
 * `url(...)` reference to a gradient that isn't there, or an attempted attribute
 * break-out — is rejected in favour of the caller's default, so a hand-edited
 * file cannot steer the rendered markup.
 */
export function sanitizeColor(value: string | undefined, fallback: string): string {
	if (!value) return fallback;
	const trimmed = value.trim();
	if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/i.test(trimmed)) return trimmed;
	if (/^[a-z]{3,20}$/i.test(trimmed)) return trimmed.toLowerCase(); // `none`, `red`, `transparent`, …
	return fallback;
}

/**
 * Relative luminance of a `#rgb`/`#rrggbb` colour, or `null` for anything else.
 *
 * Uses the sRGB coefficients rather than a plain average because the eye is far
 * more sensitive to green than to blue: averaging calls a saturated blue "light"
 * and puts black text on it, which is the exact mistake this is here to avoid.
 */
export function colorLuminance(color: string): number | null {
	const hex = color.trim();
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
	if (!m) return null;
	const body = m[1];
	const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;
	const r = parseInt(full.slice(0, 2), 16) / 255;
	const g = parseInt(full.slice(2, 4), 16) / 255;
	const b = parseInt(full.slice(4, 6), 16) / 255;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Whether two colours differ enough in luminance to be read against each other.
 *
 * A deliberately loose threshold, not a WCAG contrast ratio: the job here is
 * only to catch the "black text on a black canvas" case, and anything stricter
 * would start overriding author colours that are perfectly readable.
 */
export function hasContrast(a: string, b: string): boolean {
	const la = colorLuminance(a);
	const lb = colorLuminance(b);
	// A colour that cannot be measured (a name, `none`) is assumed fine — better
	// to keep the author's choice than to override on a guess.
	if (la === null || lb === null) return true;
	return Math.abs(la - lb) > 0.25;
}

/**
 * Picks a label colour that is readable on the shape it sits in.
 *
 * A draw.io document very often sets a shape's `fillColor` but no `fontColor` —
 * it relies on the app's own default of dark text on those pale palette fills.
 * Falling back to the *editor theme's* text colour instead makes such a label
 * near-invisible in dark mode: light grey text on a pale blue box.
 *
 * So the fill decides. Only when the shape has no fill of its own does the label
 * fall back to the theme, where it sits on the editor background as expected.
 */
export function labelColorFor(fill: string | undefined, theme: DrawioTheme): string {
	if (!fill) return theme.text;
	const luminance = colorLuminance(fill);
	// A named colour, `none`, or a transparent fill: nothing reliable to measure,
	// so the shape is treated as taking the page background.
	if (luminance === null) return theme.text;
	// Midpoint of the sRGB luminance range; the two constants are the same
	// near-black/near-white pair draw.io itself uses for its default labels.
	return luminance > 0.5 ? '#1f2430' : '#f5f7fa';
}

function numStyle(style: DrawioStyle, key: string, fallback: number): number {
	const raw = style.get(key);
	if (raw == null) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

/** Rounds to 2dp and drops a trailing `.00`, to keep the emitted SVG readable. */
function fmt(n: number): string {
	if (!Number.isFinite(n)) return '0';
	return String(Math.round(n * 100) / 100);
}

/**
 * The shape families this renderer draws natively.
 *
 * draw.io identifies the basic shapes in two different ways — as a bare style
 * flag (`ellipse;whiteSpace=wrap`) or as `shape=<name>` — so both spellings are
 * checked, in specificity order: `shape=` wins because a style may carry both
 * (`ellipse;shape=cylinder` is a cylinder, not an ellipse).
 */
export type ShapeKind =
	| 'rectangle'
	| 'rounded'
	| 'ellipse'
	| 'rhombus'
	| 'triangle'
	| 'cylinder'
	| 'hexagon'
	| 'note'
	| 'parallelogram'
	| 'cloud'
	| 'process'
	| 'text';

const SHAPE_ALIASES: Record<string, ShapeKind> = {
	cylinder: 'cylinder',
	cylinder3: 'cylinder',
	datastore: 'cylinder',
	hexagon: 'hexagon',
	note: 'note',
	parallelogram: 'parallelogram',
	cloud: 'cloud',
	process: 'process',
	trapezoid: 'parallelogram',
	step: 'hexagon',
	document: 'rectangle',
	card: 'rectangle',
	internalStorage: 'rectangle',
};

export function shapeKindOf(style: DrawioStyle): ShapeKind {
	const named = style.get('shape');
	if (named) {
		const alias = SHAPE_ALIASES[named] ?? SHAPE_ALIASES[named.toLowerCase()];
		if (alias) return alias;
	}
	if (style.has('ellipse')) return 'ellipse';
	if (style.has('rhombus')) return 'rhombus';
	if (style.has('triangle')) return 'triangle';
	if (style.has('hexagon')) return 'hexagon';
	if (style.has('cloud')) return 'cloud';
	// A "text" style is a label with no box — drawing the default rectangle around
	// it would add a border draw.io never showed.
	if (style.get('text') === '1' && !style.has('rounded')) return 'text';
	if (style.get('rounded') === '1') return 'rounded';
	return 'rectangle';
}

/** Builds the `d`/geometry attributes for one vertex's outline. */
function shapeBody(kind: ShapeKind, g: DrawioVertex['geometry'], attrs: string): string {
	const { x, y, width: w, height: h } = g;
	const points = (pts: Array<[number, number]>): string =>
		pts.map(([px, py]) => `${fmt(px)},${fmt(py)}`).join(' ');

	switch (kind) {
		case 'text':
			return ''; // label only, no outline
		case 'rounded': {
			// draw.io's default corner radius, capped so a short box does not turn
			// into a stadium shape.
			const r = Math.min(12, w / 4, h / 4);
			return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(r)}" ry="${fmt(r)}"${attrs}/>`;
		}
		case 'ellipse':
			return `<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}"${attrs}/>`;
		case 'rhombus':
			return `<polygon points="${points([
				[x + w / 2, y],
				[x + w, y + h / 2],
				[x + w / 2, y + h],
				[x, y + h / 2],
			])}"${attrs}/>`;
		case 'triangle':
			// draw.io's default triangle points right, not up.
			return `<polygon points="${points([
				[x, y],
				[x + w, y + h / 2],
				[x, y + h],
			])}"${attrs}/>`;
		case 'hexagon': {
			const inset = Math.min(w / 4, h / 2);
			return `<polygon points="${points([
				[x + inset, y],
				[x + w - inset, y],
				[x + w, y + h / 2],
				[x + w - inset, y + h],
				[x + inset, y + h],
				[x, y + h / 2],
			])}"${attrs}/>`;
		}
		case 'parallelogram': {
			const skew = Math.min(w / 4, 20);
			return `<polygon points="${points([
				[x + skew, y],
				[x + w, y],
				[x + w - skew, y + h],
				[x, y + h],
			])}"${attrs}/>`;
		}
		case 'process': {
			// A rectangle with the two inner "subroutine" bars.
			const inset = Math.min(w / 6, 10);
			return (
				`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"${attrs}/>` +
				`<line x1="${fmt(x + inset)}" y1="${fmt(y)}" x2="${fmt(x + inset)}" y2="${fmt(y + h)}"${attrs}/>` +
				`<line x1="${fmt(x + w - inset)}" y1="${fmt(y)}" x2="${fmt(x + w - inset)}" y2="${fmt(y + h)}"${attrs}/>`
			);
		}
		case 'note': {
			const fold = Math.min(w / 4, h / 4, 16);
			return (
				`<polygon points="${points([
					[x, y],
					[x + w - fold, y],
					[x + w, y + fold],
					[x + w, y + h],
					[x, y + h],
				])}"${attrs}/>` +
				`<polyline points="${points([
					[x + w - fold, y],
					[x + w - fold, y + fold],
					[x + w, y + fold],
				])}"${attrs} fill="none"/>`
			);
		}
		case 'cylinder': {
			// Body plus the elliptical cap; `ry` is draw.io's default cap depth,
			// clamped so a short cylinder keeps a visible straight section.
			const ry = Math.min(h / 4, 15);
			return (
				`<path d="M ${fmt(x)} ${fmt(y + ry)} A ${fmt(w / 2)} ${fmt(ry)} 0 0 1 ${fmt(x + w)} ${fmt(y + ry)}` +
				` L ${fmt(x + w)} ${fmt(y + h - ry)} A ${fmt(w / 2)} ${fmt(ry)} 0 0 1 ${fmt(x)} ${fmt(y + h - ry)} Z"${attrs}/>` +
				`<path d="M ${fmt(x)} ${fmt(y + ry)} A ${fmt(w / 2)} ${fmt(ry)} 0 0 0 ${fmt(x + w)} ${fmt(y + ry)}"${attrs} fill="none"/>`
			);
		}
		case 'cloud': {
			// Five overlapping bumps — enough to read as a cloud at any size.
			const cx = x + w / 2;
			const cy = y + h / 2;
			return (
				`<ellipse cx="${fmt(cx - w * 0.22)}" cy="${fmt(cy + h * 0.1)}" rx="${fmt(w * 0.26)}" ry="${fmt(h * 0.3)}"${attrs}/>` +
				`<ellipse cx="${fmt(cx + w * 0.22)}" cy="${fmt(cy + h * 0.1)}" rx="${fmt(w * 0.26)}" ry="${fmt(h * 0.3)}"${attrs}/>` +
				`<ellipse cx="${fmt(cx)}" cy="${fmt(cy - h * 0.12)}" rx="${fmt(w * 0.3)}" ry="${fmt(h * 0.34)}"${attrs}/>` +
				`<ellipse cx="${fmt(cx - w * 0.3)}" cy="${fmt(cy - h * 0.02)}" rx="${fmt(w * 0.18)}" ry="${fmt(h * 0.22)}"${attrs}/>` +
				`<ellipse cx="${fmt(cx + w * 0.3)}" cy="${fmt(cy - h * 0.02)}" rx="${fmt(w * 0.18)}" ry="${fmt(h * 0.22)}"${attrs}/>`
			);
		}
		case 'rectangle':
		default:
			return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"${attrs}/>`;
	}
}

/**
 * Wraps a label to the shape's width.
 *
 * SVG `<text>` does not wrap, so the break points have to be chosen here. Width
 * is estimated from the character count rather than measured — measuring needs a
 * laid-out DOM, which this renderer deliberately does without — using a wider
 * per-character estimate for CJK, since a Japanese label fits roughly half as
 * many glyphs per line as a Latin one and would otherwise overflow its box.
 *
 * CJK text also gets no spaces to break on, so it is broken per character when a
 * single "word" cannot fit; Latin text keeps whole words intact.
 */
export function wrapLabel(text: string, maxWidth: number, fontSize: number): string[] {
	if (!text) return [];
	const lines: string[] = [];
	for (const paragraph of text.split('\n')) {
		if (!paragraph) {
			lines.push('');
			continue;
		}
		lines.push(...wrapParagraph(paragraph, maxWidth, fontSize));
	}
	return lines;
}

/** Rough advance width of one character at the given font size. */
function charWidth(ch: string, fontSize: number): number {
	// CJK ideographs, kana and full-width punctuation are square; Latin averages
	// close to half an em in the sans-serif faces used here.
	return /[　-ヿ㐀-䶿一-鿿豈-﫿＀-｠]/.test(ch)
		? fontSize
		: fontSize * 0.55;
}

function textWidth(text: string, fontSize: number): number {
	let total = 0;
	for (const ch of text) total += charWidth(ch, fontSize);
	return total;
}

function wrapParagraph(paragraph: string, maxWidth: number, fontSize: number): string[] {
	if (textWidth(paragraph, fontSize) <= maxWidth) return [paragraph];

	const lines: string[] = [];
	let current = '';
	// Split into runs that keep Latin words whole but let CJK break anywhere.
	const tokens = paragraph.match(/[^\s　-鿿＀-｠]+|[　-鿿＀-｠]|\s+/g) ?? [paragraph];

	for (const token of tokens) {
		if (/^\s+$/.test(token)) {
			if (current) current += ' ';
			continue;
		}
		const candidate = current + token;
		if (current && textWidth(candidate, fontSize) > maxWidth) {
			lines.push(current.trimEnd());
			current = token;
		} else {
			current = candidate;
		}
		// A single token longer than the box (a long identifier, a URL) still has
		// to be split, or it runs off the shape entirely.
		while (textWidth(current, fontSize) > maxWidth && current.length > 1) {
			let cut = current.length - 1;
			while (cut > 1 && textWidth(current.slice(0, cut), fontSize) > maxWidth) cut--;
			lines.push(current.slice(0, cut));
			current = current.slice(cut);
		}
	}
	if (current) lines.push(current.trimEnd());
	return lines.length > 0 ? lines : [paragraph];
}

/** Emits a multi-line, centred `<text>` block. */
function renderLabel(
	text: string,
	cx: number,
	cy: number,
	maxWidth: number,
	style: DrawioStyle,
	theme: DrawioTheme,
	verticalAlign: 'middle' | 'top' = 'middle',
	/** The shape's resolved fill, so an unstated label colour can contrast with it. */
	fill?: string,
	/**
	 * What the label actually sits on, when that is known — the page background
	 * for a label drawn onto the canvas. Left undefined for a label drawn outside
	 * its own shape, where the backdrop could be anything.
	 */
	backdrop?: string,
	/**
	 * Vertical space the label may occupy. Text longer than this is set in a
	 * smaller size rather than being allowed to spill past the shape's edges.
	 * Undefined for a label with no such limit (one drawn below its shape).
	 */
	maxHeight?: number,
): string {
	if (!text) return '';
	const fontSize = numStyle(style, 'fontsize', DEFAULT_FONT_SIZE);
	// An explicit fontColor is the author's choice and is kept — but only while it
	// is actually legible. draw.io documents are authored on a white canvas, and
	// the AWS shape library hard-codes near-black `#232F3E` captions, so in a dark
	// editor a label drawn straight onto the page comes out black-on-black.
	//
	// The override applies only where the backdrop is actually known:
	//
	//  - `fill` set    → the label sits on that fill, which travels with it, so
	//                    the author's colour is right whatever the theme is.
	//  - `backdrop`    → the label sits on the page; if the author's colour offers
	//     given          no contrast against it, the theme's text colour wins.
	//  - neither       → the label is drawn *outside* its shape (an AWS resource
	//                    caption below its tile) and may land on anything — very
	//                    often an enclosing subnet's pale fill. Nothing here can
	//                    tell, so the author's colour is left alone rather than
	//                    swapped for one that guesses wrong just as easily.
	const authored = sanitizeColor(style.get('fontcolor'), '');
	const unreadableOnPage = backdrop !== undefined && !hasContrast(authored, backdrop);
	const color = authored && !unreadableOnPage ? authored : labelColorFor(fill, theme);
	// Shrink the text until the wrapped block fits the space it was given.
	//
	// Without this a label longer than its box simply overflowed it — the extra
	// lines were drawn above and below the border, on top of whatever else was
	// there. That damages neighbouring shapes' readability, not just its own, and
	// it happens constantly in real diagrams where a box was sized for a shorter
	// name. draw.io shrinks the text instead, and so does this.
	const usableWidth = Math.max(maxWidth, fontSize * 2);
	const { fontSize: usedSize, lines } = fitLabel(text, usableWidth, maxHeight, fontSize);
	if (lines.length === 0) return '';

	const lineHeight = usedSize * LINE_HEIGHT;
	// `dominant-baseline` support is uneven across renderers, so the first line's
	// baseline is positioned arithmetically instead: shift up by half the block,
	// then down by the ascender (~0.36em below the line's vertical centre).
	const blockHeight = lines.length * lineHeight;
	const firstBaseline =
		verticalAlign === 'top' ? cy + usedSize * 0.9 : cy - blockHeight / 2 + lineHeight / 2 + usedSize * 0.36;

	// `fontStyle` is a bitmask: 1 = bold, 2 = italic, 4 = underline.
	const fontStyle = numStyle(style, 'fontstyle', 0);
	const weight = fontStyle & 1 ? ' font-weight="bold"' : '';
	const italic = fontStyle & 2 ? ' font-style="italic"' : '';
	const underline = fontStyle & 4 ? ' text-decoration="underline"' : '';

	// `align` positions the text within its shape. Honouring it matters for
	// reading: draw.io documents use left-aligned text for anything list-like (a
	// component's responsibilities, a node's properties), and centring those
	// turns an orderly column into a ragged block.
	const align = (style.get('align') ?? 'center').toLowerCase();
	const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
	const textX = align === 'left' ? cx - usableWidth / 2 : align === 'right' ? cx + usableWidth / 2 : cx;

	const tspans = lines
		.map(
			(line, i) =>
				`<tspan x="${fmt(textX)}" y="${fmt(firstBaseline + i * lineHeight)}">${escapeXml(line)}</tspan>`,
		)
		.join('');

	return (
		`<text text-anchor="${anchor}" font-family="${FONT_FAMILY}" font-size="${fmt(usedSize)}"` +
		` fill="${color}"${weight}${italic}${underline}>${tspans}</text>`
	);
}

/**
 * Size and inset of the small badge draw.io draws in a group frame's corner.
 *
 * Fixed rather than proportional: the badge marks what kind of frame this is
 * (an AWS Cloud, a VPC, a subnet), so it should look the same whether the frame
 * encloses two shapes or fifty.
 */
const GROUP_BADGE_SIZE = 20;
const GROUP_BADGE_MARGIN = 6;

/** Vertical space a container frame's title may use before it must shrink. */
const CONTAINER_HEADER_HEIGHT = 28;

/** Smallest font a shrunk label is allowed to reach, in diagram units. */
const MIN_LABEL_FONT_SIZE = 6;

/**
 * Wraps `text` to `maxWidth`, shrinking the font until the result also fits
 * `maxHeight`.
 *
 * Returns the size actually used along with the wrapped lines. When no size down
 * to `MIN_LABEL_FONT_SIZE` fits, the smallest is used and the text is allowed to
 * overflow: an unreadably tiny label is no better than a clipped one, and
 * dropping the text entirely would hide information the diagram is carrying.
 */
export function fitLabel(
	text: string,
	maxWidth: number,
	maxHeight: number | undefined,
	fontSize: number,
): { fontSize: number; lines: string[] } {
	let lines = wrapLabel(text, maxWidth, fontSize);
	if (maxHeight === undefined || maxHeight <= 0) return { fontSize, lines };

	let size = fontSize;
	while (lines.length * size * LINE_HEIGHT > maxHeight && size > MIN_LABEL_FONT_SIZE) {
		// A full point at a time: fine enough that the step is invisible, coarse
		// enough that a long label in a small box settles in a few iterations.
		size -= 1;
		lines = wrapLabel(text, maxWidth, size);
	}
	return { fontSize: size, lines };
}

/**
 * Midpoint of the longest straight run in a polyline.
 *
 * Used to position an edge's label: the longest segment is the part of the route
 * with actual room for text, and it is never an elbow, which is where a naive
 * "middle of the path" lands on a right-angled connector.
 */
function longestSegmentMidpoint(pts: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number } {
	if (pts.length === 0) return { x: 0, y: 0 };
	if (pts.length === 1) return pts[0];
	let best = 0;
	let bestLength = -1;
	for (let i = 1; i < pts.length; i++) {
		const length = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
		if (length > bestLength) {
			bestLength = length;
			best = i;
		}
	}
	return { x: (pts[best].x + pts[best - 1].x) / 2, y: (pts[best].y + pts[best - 1].y) / 2 };
}

/** Id of the shared arrowhead marker; suffixed per-diagram to stay unique. */
function markerId(uid: string, color: string): string {
	// Colour is part of the id because SVG markers do not inherit the referencing
	// line's stroke: one marker per distinct colour is needed, or every arrowhead
	// comes out in whichever colour happened to be defined first.
	return `mlp-drawio-arrow-${uid}-${color.replace(/[^a-z0-9]/gi, '')}`;
}

/**
 * Trims an edge's last segment so the arrowhead stops at the shape's boundary
 * instead of at its centre.
 *
 * Endpoints resolved from `source`/`target` are centres (see drawio.ts), so an
 * untrimmed arrow is drawn *underneath* the target box and its head disappears.
 * The exact intersection depends on the shape's outline; backing off along the
 * final segment by the box's half-extent in the direction of travel is a close
 * approximation for every shape drawn here, and is exact for rectangles.
 */
function trimToBoundary(
	point: { x: number; y: number },
	from: { x: number; y: number },
	box: DrawioVertex['geometry'] | undefined,
): { x: number; y: number } {
	if (!box) return point;
	const dx = point.x - from.x;
	const dy = point.y - from.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return point;
	const ux = dx / len;
	const uy = dy / len;
	// Distance from the centre to the box edge along (ux, uy).
	const halfW = box.width / 2;
	const halfH = box.height / 2;
	const tx = Math.abs(ux) > 1e-6 ? halfW / Math.abs(ux) : Infinity;
	const ty = Math.abs(uy) > 1e-6 ? halfH / Math.abs(uy) : Infinity;
	const dist = Math.min(tx, ty, len);
	return { x: point.x - ux * dist, y: point.y - uy * dist };
}

/**
 * The fixed connection point an edge was pinned to, if any.
 *
 * `exitX`/`exitY` and `entryX`/`entryY` are *fractions of the shape's box* —
 * `exitX=1;exitY=0.5` means "leave from the middle of the right edge". Authors
 * set these deliberately, to say which side of a box a relationship belongs to,
 * so honouring them is worth a lot when the point is to read the diagram: it is
 * the difference between "the reply goes back out the top" and a line leaving
 * from wherever the geometry happened to fall.
 *
 * Returns `null` when the edge does not pin that end, leaving the caller to fall
 * back to the shape's centre.
 */
export function fixedConnectionPoint(
	style: DrawioStyle,
	box: DrawioGeometry | undefined,
	which: 'exit' | 'entry',
): { x: number; y: number } | null {
	if (!box) return null;
	const fx = style.get(`${which}x`);
	const fy = style.get(`${which}y`);
	if (fx === undefined || fy === undefined) return null;
	const rx = Number(fx);
	const ry = Number(fy);
	if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
	return { x: box.x + box.width * rx, y: box.y + box.height * ry };
}

/**
 * Whether an edge should be drawn as right-angled segments rather than a
 * straight line.
 *
 * `orthogonalEdgeStyle` is draw.io's *default* connector, so this is what most
 * real diagrams use — drawing those straight was the single most visible
 * difference from the app. `elbowEdgeStyle` is the older spelling of the same
 * idea. An edge that explicitly asks for `none` is a deliberate straight line
 * and is left alone.
 */
export function isOrthogonalEdge(style: DrawioStyle): boolean {
	const kind = (style.get('edgestyle') ?? '').toLowerCase();
	if (kind === 'none') return false;
	if (kind === 'orthogonaledgestyle' || kind === 'elbowedgestyle' || kind === 'entityrelationedgestyle') return true;
	// `elbow=horizontal|vertical` selects a routing without naming an edgeStyle.
	return style.has('elbow');
}

/** How close two coordinates must be to count as already lined up. */
const ALIGNMENT_EPSILON = 2;

/**
 * Computes the elbow points for a right-angled connector between two shapes.
 *
 * Returns only the *intermediate* points; the caller still trims the ends
 * against each shape's outline. An empty result means a straight line is
 * correct — which is exactly the case when the two shapes already line up on an
 * axis, and is why an aligned pair does not get a spurious dog-leg.
 *
 * The choice of which axis to turn on first follows draw.io: leave horizontally
 * when the shapes are mainly side by side, vertically when they are mainly
 * stacked. Picking the other one produces a route that doubles back across the
 * shape it just left, which reads as a mistake even though it is the same length.
 */
export function routeOrthogonal(
	from: { x: number; y: number },
	to: { x: number; y: number },
	sourceBox?: DrawioGeometry,
	targetBox?: DrawioGeometry,
	/**
	 * Shapes the route should avoid crossing. The two endpoints' own boxes are
	 * excluded by the caller — a connector necessarily touches those.
	 */
	obstacles: readonly DrawioGeometry[] = [],
): Array<{ x: number; y: number }> {
	const dx = to.x - from.x;
	const dy = to.y - from.y;

	// Already on one axis: a straight line *is* the orthogonal route.
	if (Math.abs(dx) <= ALIGNMENT_EPSILON || Math.abs(dy) <= ALIGNMENT_EPSILON) return [];

	// Side by side: leave through the left/right face, so turn on x first. The
	// comparison uses the gap between the shapes' facing edges rather than the
	// centre distance, so a wide box next to a narrow one is still judged by how
	// far apart they actually sit.
	const horizontalGap = gapBetween(from.x, to.x, sourceBox?.width, targetBox?.width);
	const verticalGap = gapBetween(from.y, to.y, sourceBox?.height, targetBox?.height);

	if (horizontalGap >= verticalGap) {
		// Out sideways, across, then in vertically. The turn happens on a vertical
		// corridor; the midpoint is the natural choice, but it is nudged aside when
		// that column runs through a shape.
		const midX = clearCorridor(
			from.x + dx / 2,
			(x) => segmentHitsAny(obstacles, { x, y: from.y }, { x, y: to.y }, 'vertical'),
			Math.min(from.x, to.x),
			Math.max(from.x, to.x),
		);
		return [
			{ x: midX, y: from.y },
			{ x: midX, y: to.y },
		];
	}
	const midY = clearCorridor(
		from.y + dy / 2,
		(y) => segmentHitsAny(obstacles, { x: from.x, y }, { x: to.x, y }, 'horizontal'),
		Math.min(from.y, to.y),
		Math.max(from.y, to.y),
	);
	return [
		{ x: from.x, y: midY },
		{ x: to.x, y: midY },
	];
}

/** Clearance kept between a routed line and the shape it passes. */
const OBSTACLE_MARGIN = 10;

/**
 * Finds a corridor position near `preferred` that no shape blocks.
 *
 * A long connector's midpoint elbow very often lands inside some *other* box —
 * in a nested diagram (a pod reaching a database past two enclosing frames) the
 * straight midpoint route cut clean through both. Rather than implementing a
 * full routing graph, the corridor is stepped outwards from the preferred
 * position until it is clear, which is enough to get such a line out of the
 * shapes it was crossing.
 *
 * Falls back to `preferred` when nothing within the search is clear: a line in
 * the position draw.io itself would have used beats one flung far off the
 * diagram to satisfy this heuristic.
 */
function clearCorridor(
	preferred: number,
	blocked: (position: number) => boolean,
	lower: number,
	upper: number,
): number {
	if (!blocked(preferred)) return preferred;
	// Search outwards in both directions, staying inside the span the two
	// endpoints define so the detour cannot leave the region of the diagram the
	// connector belongs to.
	const span = Math.max(upper - lower, 1);
	const step = Math.max(span / 16, 4);
	for (let offset = step; offset <= span; offset += step) {
		if (preferred + offset <= upper && !blocked(preferred + offset)) return preferred + offset;
		if (preferred - offset >= lower && !blocked(preferred - offset)) return preferred - offset;
	}
	return preferred;
}

/** Whether an axis-aligned segment passes through any of the given boxes. */
function segmentHitsAny(
	obstacles: readonly DrawioGeometry[],
	a: { x: number; y: number },
	b: { x: number; y: number },
	orientation: 'horizontal' | 'vertical',
): boolean {
	for (const box of obstacles) {
		const left = box.x - OBSTACLE_MARGIN;
		const right = box.x + box.width + OBSTACLE_MARGIN;
		const top = box.y - OBSTACLE_MARGIN;
		const bottom = box.y + box.height + OBSTACLE_MARGIN;
		if (orientation === 'vertical') {
			if (a.x <= left || a.x >= right) continue;
			if (Math.max(a.y, b.y) <= top || Math.min(a.y, b.y) >= bottom) continue;
		} else {
			if (a.y <= top || a.y >= bottom) continue;
			if (Math.max(a.x, b.x) <= left || Math.min(a.x, b.x) >= right) continue;
		}
		return true;
	}
	return false;
}

/** Centre-to-centre distance along one axis, less the two half-extents. */
function gapBetween(a: number, b: number, extentA = 0, extentB = 0): number {
	return Math.abs(b - a) - extentA / 2 - extentB / 2;
}

function renderEdge(
	edge: DrawioEdge,
	vertices: Map<string, DrawioVertex>,
	theme: DrawioTheme,
	uid: string,
	markers: Set<string>,
	/** Boxes routing should avoid; the edge's own endpoints are removed below. */
	allObstacles: readonly DrawioGeometry[] = [],
): string {
	const from = edge.from;
	const to = edge.to;
	if (!from || !to) return '';

	const stroke = sanitizeColor(edge.style.get('strokecolor'), theme.stroke);
	const strokeWidth = numStyle(edge.style, 'strokewidth', 1);
	const dashed = edge.style.get('dashed') === '1' ? ' stroke-dasharray="6 4"' : '';

	// The connected shapes come from the edge's own id references. They used to be
	// recovered by looking for a vertex whose centre matched the endpoint, which
	// picked the wrong box when two shapes shared a centre and found none at all
	// when a coordinate was fractionally off.
	const sourceBox = edge.sourceId ? vertices.get(edge.sourceId)?.geometry : undefined;
	const targetBox = edge.targetId ? vertices.get(edge.targetId)?.geometry : undefined;

	// The shapes this edge connects are not obstacles to it — a connector has to
	// reach them — so they are dropped from the list before routing.
	const obstacles = allObstacles.filter((b) => b !== sourceBox && b !== targetBox);

	// A pinned connection point replaces the shape's centre outright: the author
	// chose that spot, and it already sits on the outline, so it must not be
	// trimmed back afterwards the way a centre-derived endpoint is.
	const exitPoint = fixedConnectionPoint(edge.style, sourceBox, 'exit');
	const entryPoint = fixedConnectionPoint(edge.style, targetBox, 'entry');

	// Waypoints the author placed win; otherwise, for draw.io's default
	// orthogonal edge style, the elbows are computed here (see routeOrthogonal).
	const routeFrom = exitPoint ?? from;
	const routeTo = entryPoint ?? to;

	const routed =
		edge.waypoints.length > 0
			? edge.waypoints
			: isOrthogonalEdge(edge.style)
				? routeOrthogonal(routeFrom, routeTo, exitPoint ? undefined : sourceBox, entryPoint ? undefined : targetBox, obstacles)
				: [];

	// Back the endpoints off each shape's outline so the arrowhead is visible —
	// but only where the point came from the shape's centre. A pinned point is
	// already on the boundary, and trimming it again would pull the line off the
	// spot the author picked.
	const beforeLast = routed.length > 0 ? routed[routed.length - 1] : routeFrom;
	const end = entryPoint ?? trimToBoundary(to, beforeLast, targetBox);

	const firstNext = routed.length > 0 ? routed[0] : end;
	const start = exitPoint ?? trimToBoundary(from, firstNext, sourceBox);

	const pts = [start, ...routed, end];
	const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${fmt(p.x)} ${fmt(p.y)}`).join(' ');

	// `endArrow=none` is how draw.io marks a plain line. `startArrow` is the
	// opposite end, and is *not* cosmetic: an edge carrying both heads is a
	// two-way relationship, and drawing only one of them tells the reader
	// something the diagram does not say.
	let markerAttr = '';
	if (edge.style.get('endarrow') !== 'none') {
		markers.add(stroke);
		markerAttr += ` marker-end="url(#${markerId(uid, stroke)})"`;
	}
	// Absent by default — draw.io draws no head at the source unless asked.
	const startArrow = edge.style.get('startarrow');
	if (startArrow !== undefined && startArrow !== 'none') {
		markers.add(stroke);
		// `orient="auto-start-reverse"` on the shared marker makes the same
		// definition point backwards when used as `marker-start`, so one marker
		// serves both ends.
		markerAttr += ` marker-start="url(#${markerId(uid, stroke)})"`;
	}

	const line =
		`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${fmt(strokeWidth)}"` +
		` stroke-linecap="round" stroke-linejoin="round"${dashed}${markerAttr}/>`;

	if (!edge.label) return line;
	// Place the label at the midpoint of the path's *longest* segment, on a small
	// backing plate so it stays readable where it crosses the line it belongs to.
	//
	// Taking the geometric midpoint instead put the label right on an elbow of a
	// routed edge — which is exactly where the line turns, and often just inside
	// the shape it was heading for. The longest straight run is the one stretch
	// with room for text.
	const { x: midX, y: midY } = longestSegmentMidpoint(pts);
	const fontSize = numStyle(edge.style, 'fontsize', DEFAULT_FONT_SIZE - 1);
	const labelLines = wrapLabel(edge.label, 160, fontSize);
	const plateW = Math.max(...labelLines.map((l) => textWidth(l, fontSize)), 0) + 8;
	const plateH = labelLines.length * fontSize * LINE_HEIGHT + 2;
	const plate =
		`<rect x="${fmt(midX - plateW / 2)}" y="${fmt(midY - plateH / 2)}" width="${fmt(plateW)}" height="${fmt(plateH)}"` +
		` fill="${theme.fill}" stroke="none" rx="2"/>`;
	// The plate is painted in `theme.fill`, so that is what the label sits on.
	return line + plate + renderLabel(edge.label, midX, midY, 160, edge.style, theme, 'middle', theme.fill, theme.fill);
}

/**
 * Whether a shape is a container whose label belongs in a header band rather
 * than across the middle.
 *
 * Beyond draw.io's own `swimlane`/`container` flags, this catches the AWS
 * shape library's group boxes (`mxgraph.aws4.group`, the VPC/subnet/account
 * frames), and infers the same for any large, unfilled box: those exist to
 * enclose other shapes, and centring their title paints it straight over the
 * contents — which is exactly what an "AWS Cloud" or "VPC" frame did.
 */
function isContainerShape(style: DrawioStyle, g: DrawioVertex['geometry'], fill: string): boolean {
	if (style.has('swimlane') || style.get('container') === '1') return true;
	const shape = (style.get('shape') ?? '').toLowerCase();
	if (shape.includes('group')) return true;
	// `verticalAlign=top` is how draw.io records "title at the top of the box",
	// which is precisely the container convention the AWS frames use.
	if (style.get('verticalalign') === 'top' && g.width >= 120 && g.height >= 120) return true;
	// An unfilled box big enough to hold other shapes is a frame in all but name.
	return fill === 'none' && g.width >= 200 && g.height >= 160;
}

/**
 * The colour a shape is actually painted with.
 *
 * `fillColor=none` is draw.io's explicit "transparent", used by every group
 * frame; defaulting it to the theme's own fill painted those frames as opaque
 * boxes that hid whatever sat behind them. Shared by the renderer and by the
 * obstacle scan, which uses it to tell a frame from a solid shape — the two must
 * agree, or a frame counts as an obstacle in one place and not the other.
 */
function resolvedFill(vertex: DrawioVertex, theme: DrawioTheme): string {
	const raw = vertex.style.get('fillcolor');
	if (raw?.trim().toLowerCase() === 'none') return 'none';
	if (shapeKindOf(vertex.style) === 'text') return 'none';
	return sanitizeColor(raw, theme.fill);
}

/**
 * Draws the AWS architecture symbol for a shape, over the coloured tile.
 *
 * draw.io names the symbol in one of three places depending on the shape:
 * `resIcon=` for a service tile, `grIcon=` for a group/container frame, and
 * plain `shape=` for a standalone symbol. All three are checked, most specific
 * first, because a resource tile carries both `shape=...resourceIcon` (the tile)
 * and `resIcon=...` (the symbol on it) — reading `shape` there would draw the
 * generic tile outline a second time instead of the service's own mark.
 *
 * ## Geometry is not touched
 *
 * The path data is emitted exactly as stored. Fitting it to the shape's box is
 * done with a nested `<svg>` and its `viewBox`, which scales at *draw* time and
 * leaves the coordinates alone; rewriting them to a new size would be a redraw
 * of the artwork rather than a rendering of it, which the shapes' terms do not
 * allow (see LICENSE-SHAPES / THIRD-PARTY-NOTICES.md). `preserveAspectRatio`
 * defaults to `xMidYMid meet`, so a shape given a non-square box is centred
 * rather than stretched.
 *
 * ## Colour is not invented
 *
 * The stencils carry no colours. A service tile's symbol is drawn in the tile's
 * stroke colour — which is what the diagram's own `strokeColor` says, normally
 * white on the service-coloured tile — and a frame's symbol in the frame's
 * stroke colour. Nothing here picks a colour of its own, in either theme.
 */
function renderAwsGlyph(
	vertex: DrawioVertex,
	fill: string,
	stroke: string,
	awsShape: AwsShapeLookup | undefined,
): string {
	if (!awsShape) return '';

	const style = vertex.style;
	const isResourceTile = style.get('resicon') !== undefined;
	const key =
		awsShapeKeyOf(style.get('resicon')) ??
		awsShapeKeyOf(style.get('gricon')) ??
		(isResourceTile ? null : awsShapeKeyOf(style.get('shape')));
	if (!key) return '';

	const shape = awsShape(key);
	if (!shape || !(shape.w > 0) || !(shape.h > 0)) return '';

	const g = vertex.geometry;
	const isGroupBadge = style.get('gricon') !== undefined;

	let x: number;
	let y: number;
	let w: number;
	let h: number;

	if (isGroupBadge) {
		// A frame's badge is a small mark in the top-left corner, NOT artwork
		// stretched over the frame. Scaling it to the box painted a VPC's badge
		// across the entire diagram, burying everything inside it.
		const size = GROUP_BADGE_SIZE;
		x = g.x + GROUP_BADGE_MARGIN;
		y = g.y + GROUP_BADGE_MARGIN;
		w = size;
		h = size;
	} else {
		// A resource tile's symbol sits inside the tile with a margin, the way
		// draw.io draws it; a bare symbol uses the whole box.
		const inset = isResourceTile ? Math.min(g.width, g.height) * 0.18 : 0;
		x = g.x + inset;
		y = g.y + inset;
		w = Math.max(g.width - inset * 2, 1);
		h = Math.max(g.height - inset * 2, 1);
	}

	// On a filled tile the symbol takes the tile's stroke colour (white, in
	// AWS's own palette); an unfilled frame has no tile to contrast with, so its
	// badge takes the frame's stroke colour instead.
	const glyphColor = fill === 'none' ? stroke : stroke === 'none' ? fill : stroke;

	return (
		`<svg x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"` +
		` viewBox="0 0 ${fmt(shape.w)} ${fmt(shape.h)}" overflow="visible">` +
		`<path d="${escapeXml(shape.d)}" fill="${glyphColor}"/></svg>`
	);
}

/** `mxgraph.aws4.ec2` -> `ec2`; null for anything outside that library. */
function awsShapeKeyOf(name: string | undefined): string | null {
	if (!name) return null;
	const trimmed = name.trim().toLowerCase();
	const prefix = 'mxgraph.aws4.';
	return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : null;
}

function renderVertex(vertex: DrawioVertex, theme: DrawioTheme, awsShape?: AwsShapeLookup): string {
	const kind = shapeKindOf(vertex.style);
	const fill = resolvedFill(vertex, theme);
	const stroke = sanitizeColor(vertex.style.get('strokecolor'), kind === 'text' ? 'none' : theme.stroke);
	const strokeWidth = numStyle(vertex.style, 'strokewidth', 1);
	const dashed = vertex.style.get('dashed') === '1' ? ' stroke-dasharray="6 4"' : '';
	const opacity = numStyle(vertex.style, 'opacity', 100) / 100;
	const opacityAttr = opacity < 1 ? ` opacity="${fmt(opacity)}"` : '';

	const attrs = ` fill="${fill}" stroke="${stroke}" stroke-width="${fmt(strokeWidth)}"${dashed}${opacityAttr}`;
	const body = shapeBody(kind, vertex.geometry, attrs) + renderAwsGlyph(vertex, fill, stroke, awsShape);

	const g = vertex.geometry;
	// `fill` is passed so a shape that sets a colour but no fontColor gets a label
	// that contrasts with *that* colour rather than with the editor theme.
	// A `none` fill means the label sits on the page, so the theme decides.
	const labelFill = fill === 'none' ? undefined : fill;

	// AWS resource icons put their caption *below* the tile
	// (`verticalLabelPosition=bottom`), which is why those captions have to be
	// drawn outside the shape: kept inside, a name like "RDS" was painted in
	// dark text on the icon's dark blue tile and effectively disappeared.
	if (vertex.style.get('verticallabelposition') === 'bottom') {
		return (
			body +
			renderLabel(
				vertex.label,
				g.x + g.width / 2,
				g.y + g.height + 2,
				// Captions below an icon are not confined to the icon's own width —
				// draw.io lets them run wider — so allow a readable minimum.
				Math.max(g.width, 90),
				vertex.style,
				theme,
				'top',
				undefined, // drawn outside the shape, so no fill of its own
				// Deliberately no backdrop: a caption below an AWS icon usually lands
				// on an enclosing subnet's fill, not on the page, and guessing "page"
				// here made those captions light-on-pale and unreadable.
				undefined,
			)
		);
	}

	// With no fill of its own the shape is transparent, so the label really does
	// sit on the page — that is a backdrop worth checking the author's colour
	// against. A filled shape carries its own, so none is passed.
	const backdrop = labelFill === undefined ? theme.fill : undefined;
	const label = isContainerShape(vertex.style, g, fill)
		? renderLabel(
				vertex.label,
				g.x + g.width / 2,
				g.y + 4,
				g.width - 8,
				vertex.style,
				theme,
				'top',
				labelFill,
				backdrop,
				// A frame's title gets the header band only — it must not grow down
				// over the shapes the frame contains.
				CONTAINER_HEADER_HEIGHT,
			)
		: renderLabel(
				vertex.label,
				g.x + g.width / 2,
				g.y + g.height / 2,
				g.width - 8,
				vertex.style,
				theme,
				'middle',
				labelFill,
				backdrop,
				// Keep the text inside the shape, less a small inset so it does not
				// touch the border.
				Math.max(g.height - 8, 1),
			);

	return body + label;
}

/**
 * Renders one page to a complete `<svg>` element.
 *
 * `uid` must be unique per rendered diagram in the document: SVG ids share one
 * global namespace across the whole page, so two diagrams using the same marker
 * id would have the second one's arrowheads silently resolve to the first one's
 * definition — and, once the first diagram is edited away, disappear entirely.
 *
 * Vertices are drawn before edges so connectors sit on top of the boxes they
 * join, matching draw.io's own painting order for the default z-order.
 */
export function renderPageSvg(page: DrawioPage, theme: DrawioTheme, uid: string, awsShape?: AwsShapeLookup): string {
	const vertices = new Map<string, DrawioVertex>();
	for (const shape of page.shapes) if (shape.kind === 'vertex') vertices.set(shape.id, shape);

	const markerColors = new Set<string>();
	const vertexMarkup = page.shapes
		.filter((s): s is DrawioVertex => s.kind === 'vertex')
		.map((v) => renderVertex(v, theme, awsShape))
		.join('');
	// Only leaf shapes obstruct a connector. A container frame (a VPC, a subnet,
	// an EKS cluster box) is meant to be crossed — treating those as obstacles
	// would leave every line that enters a frame with nowhere to go, and the
	// routing would give up and cut through everything anyway.
	const obstacles = page.shapes
		.filter((s): s is DrawioVertex => s.kind === 'vertex')
		.filter((v) => !isContainerShape(v.style, v.geometry, resolvedFill(v, theme)))
		.map((v) => v.geometry);

	const edgeMarkup = page.shapes
		.filter((s): s is DrawioEdge => s.kind === 'edge')
		.map((e) => renderEdge(e, vertices, theme, uid, markerColors, obstacles))
		.join('');

	const defs = [...markerColors]
		.map(
			(color) =>
				`<marker id="${markerId(uid, color)}" viewBox="0 0 10 10" refX="9" refY="5"` +
				` markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
				`<path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`,
		)
		.join('');

	const b = page.bounds;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(b.x)} ${fmt(b.y)} ${fmt(b.width)} ${fmt(b.height)}"` +
		` width="${fmt(b.width)}" height="${fmt(b.height)}" role="img">` +
		(defs ? `<defs>${defs}</defs>` : '') +
		vertexMarkup +
		edgeMarkup +
		'</svg>'
	);
}

/** Renders the diagram's first page — what a single-diagram fence shows. */
export function renderDiagramSvg(
	diagram: DrawioDiagram,
	theme: DrawioTheme,
	uid: string,
	pageIndex = 0,
	awsShape?: AwsShapeLookup,
): string {
	const page = diagram.pages[pageIndex] ?? diagram.pages[0];
	if (!page) return '';
	return renderPageSvg(page, theme, uid, awsShape);
}
