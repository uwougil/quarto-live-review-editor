/**
 * Converts draw.io's AWS stencil library into the path table the renderer uses.
 *
 * Reads `vendor/aws4.xml` — draw.io's `src/main/webapp/stencils/aws4.xml`,
 * vendored so the build is reproducible and works offline — and writes
 * `dist/aws4-shapes.json`.
 *
 * ## Why a conversion is needed at all
 *
 * The stencils are mxGraph's own XML dialect: each shape is a list of
 * `<move>` / `<line>` / `<curve>` / `<arc>` / `<close>` elements with numeric
 * attributes. SVG cannot draw those directly, so they are rewritten as the
 * directly equivalent SVG path commands. The mapping is exact and mechanical —
 * mxGraph's primitives were modelled on SVG's, down to the arc flags:
 *
 *     move  x,y                        -> M x y
 *     line  x,y                        -> L x y
 *     curve x1,y1,x2,y2,x3,y3          -> C x1 y1 x2 y2 x3 y3
 *     arc   rx,ry,x-axis-rotation,     -> A rx ry rot large-arc sweep x y
 *           large-arc-flag,sweep-flag,x,y
 *     close                            -> Z
 *
 * ## What this script deliberately does NOT do
 *
 * Every coordinate is copied through verbatim. Nothing is rounded, re-scaled,
 * simplified, merged, minified, or re-drawn, and no colour is introduced. That
 * is a licensing requirement, not a stylistic preference: the shapes are
 * redistributed under draw.io's terms (see LICENSE-SHAPES), which cover
 * derivatives including "conversions to other formats", so the conversion is
 * kept to the minimum technically necessary to display the shapes at all.
 * Anything that altered the geometry would be a redraw, not a format change.
 *
 * Colour is likewise not this script's business: the stencils carry none, and
 * the renderer takes each shape's colour from the user's own `.drawio` file.
 *
 * ## Shape keys
 *
 * draw.io registers a stencil under `mxgraph.aws4.<name>`, where `<name>` is the
 * shape's `name` attribute lowercased with spaces turned into underscores (see
 * `mxStencilRegistry.addStencil` in drawio's Graph.js). A diagram then refers to
 * it as `shape=mxgraph.aws4.group` / `resIcon=mxgraph.aws4.ec2`. The same
 * normalisation is applied here so a style string can be looked up directly.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(root, 'vendor', 'aws4.xml');
const outFile = join(root, 'dist', 'aws4-shapes.json');

/** draw.io's own key normalisation, mirrored exactly. */
export function stencilKey(name) {
	return name.replace(/ /g, '_').toLowerCase();
}

/** Reads the numeric attributes of one primitive element. */
function attrs(tag) {
	const out = {};
	for (const m of tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
	return out;
}

/**
 * Rewrites one `<foreground>`/`<background>` body as an SVG path string.
 *
 * Returns `null` when the body contains no drawing commands, so a shape that
 * only sets styles is skipped rather than stored as an empty path.
 */
function toPathData(body) {
	const parts = [];
	for (const m of body.matchAll(/<(move|line|curve|arc|close)\b([^>]*)\/?>/g)) {
		const [, kind, rawAttrs] = m;
		const a = attrs(rawAttrs);
		switch (kind) {
			case 'move':
				parts.push(`M ${a.x} ${a.y}`);
				break;
			case 'line':
				parts.push(`L ${a.x} ${a.y}`);
				break;
			case 'curve':
				parts.push(`C ${a.x1} ${a.y1} ${a.x2} ${a.y2} ${a.x3} ${a.y3}`);
				break;
			case 'arc':
				// mxGraph names these exactly as SVG does, so they pass straight through.
				parts.push(`A ${a.rx} ${a.ry} ${a['x-axis-rotation']} ${a['large-arc-flag']} ${a['sweep-flag']} ${a.x} ${a.y}`);
				break;
			case 'close':
				parts.push('Z');
				break;
		}
	}
	return parts.length > 0 ? parts.join(' ') : null;
}

async function main() {
	const xml = await readFile(sourceFile, 'utf8');
	const shapes = {};
	let skipped = 0;

	for (const m of xml.matchAll(/<shape\b([^>]*)>([\s\S]*?)<\/shape>/g)) {
		const header = attrs(m[1]);
		const body = m[2];
		if (!header.name) continue;

		// `<background>` holds the outline that takes the shape's fill;
		// `<foreground>` holds the glyph drawn over it. Most AWS resource icons
		// use only a foreground. Both are collected so a shape that splits its
		// drawing across the two is not rendered half-finished.
		const sections = [];
		for (const sec of body.matchAll(/<(background|foreground)>([\s\S]*?)<\/\1>/g)) {
			const d = toPathData(sec[2]);
			if (d) sections.push(d);
		}
		if (sections.length === 0) {
			skipped++;
			continue;
		}

		shapes[stencilKey(header.name)] = {
			w: Number(header.w),
			h: Number(header.h),
			d: sections.join(' '),
		};
	}

	await mkdir(dirname(outFile), { recursive: true });
	// No pretty-printing: this file is data the webview parses, never read by a
	// person, and the indentation would cost more than the shapes themselves.
	await writeFile(outFile, JSON.stringify(shapes));

	const count = Object.keys(shapes).length;
	const bytes = (await readFile(outFile)).byteLength;
	console.log(`aws shapes: wrote ${count} shapes (${(bytes / 1048576).toFixed(2)}MB) to dist/aws4-shapes.json`);
	if (skipped > 0) console.log(`aws shapes: skipped ${skipped} shape(s) with no drawing commands`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
