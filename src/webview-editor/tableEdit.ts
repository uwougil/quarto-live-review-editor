/**
 * Structural edits to a Markdown table — adding a row or a column.
 *
 * Kept as pure functions over plain data, separate from the widget that calls
 * them. Cell editing can write back one span at a time because only one cell
 * changes; adding a row or a column changes the shape of every line (a new
 * column touches the header, the delimiter row, and every data row), so the
 * table is rebuilt and replaced whole. That makes getting the *text* right the
 * whole problem, and text is exactly what can be unit-tested without a DOM.
 */

import type { ColumnAlign } from './livePreviewPlugin';

/** The pieces of a table needed to rewrite it. */
export interface TableEditModel {
	/** Cell text, header row(s) first. */
	rows: string[][];
	/** How many leading entries of `rows` are header rows (GFM allows only 1). */
	headerRowCount: number;
	align: ColumnAlign[];
	/**
	 * Indentation carried by every line of the table, e.g. the two spaces of a
	 * table nested under a list item. Reapplied to each rebuilt line so the
	 * table stays inside its list item.
	 */
	indent: string;
}

/** The delimiter-row spec for one column's alignment (`:--`, `:-:`, `--:`, `---`). */
export function delimiterFor(align: ColumnAlign): string {
	switch (align) {
		case 'left':
			return ':---';
		case 'center':
			return ':--:';
		case 'right':
			return '---:';
		default:
			return '---';
	}
}

/**
 * A cell's text, escaped so it cannot break the row it is written into.
 *
 * Mirrors `sanitizeCellInput`: a newline would split the row across two lines
 * and a bare `|` would invent a column boundary.
 */
function escapeCell(text: string): string {
	return text.replace(/\r?\n/g, ' ').replace(/(^|[^\\])\|/g, '$1\\|');
}

/** Renders a table back to Markdown, one line per row plus the delimiter row. */
export function renderTableMarkdown(model: TableEditModel): string {
	const width = model.align.length || model.rows[0]?.length || 0;
	const line = (cells: string[]): string => {
		const padded = Array.from({ length: width }, (_, i) => escapeCell(cells[i] ?? '').trim());
		return `${model.indent}| ${padded.join(' | ')} |`;
	};
	const out: string[] = [];
	// GFM requires exactly one header row followed by the delimiter row. A model
	// with no header at all still needs one, or the result is not a table.
	const headerCount = Math.max(1, model.headerRowCount);
	for (let i = 0; i < headerCount; i++) out.push(line(model.rows[i] ?? []));
	out.push(`${model.indent}| ${Array.from({ length: width }, (_, i) => delimiterFor(model.align[i] ?? null)).join(' | ')} |`);
	for (let i = headerCount; i < model.rows.length; i++) out.push(line(model.rows[i]));
	return out.join('\n');
}

/**
 * Inserts an empty row at `index` (counted in `rows`, header rows included).
 *
 * `index` is clamped, and never allowed above the header: a row inserted before
 * the header row would become the header itself and silently retitle the table.
 */
export function insertRow(model: TableEditModel, index: number): TableEditModel {
	const width = model.align.length || model.rows[0]?.length || 0;
	const headerCount = Math.max(1, model.headerRowCount);
	const at = Math.min(Math.max(index, headerCount), model.rows.length);
	const rows = model.rows.slice();
	rows.splice(at, 0, new Array(width).fill(''));
	return { ...model, rows };
}

/**
 * Inserts an empty column at `index`, in every row and in the alignment list.
 *
 * The new column is unaligned; the delimiter row grows with it, which is what
 * keeps the table's column count — fixed by that row under GFM — consistent
 * with the rows above and below.
 */
export function insertColumn(model: TableEditModel, index: number): TableEditModel {
	const width = model.align.length || model.rows[0]?.length || 0;
	const at = Math.min(Math.max(index, 0), width);
	const rows = model.rows.map((cells) => {
		const next = cells.slice();
		// Pad a short row out to `at` first, or `splice` would land the new cell
		// at the end of that row instead of in the intended column.
		while (next.length < at) next.push('');
		next.splice(at, 0, '');
		return next;
	});
	const align = model.align.slice();
	while (align.length < at) align.push(null);
	align.splice(at, 0, null);
	return { ...model, rows, align };
}

/**
 * Removes the row at `index`. The header row is never removed — a table without
 * one is not a table — and neither is the last remaining data row's absence a
 * problem, since a header-only table is valid.
 */
export function deleteRow(model: TableEditModel, index: number): TableEditModel {
	const headerCount = Math.max(1, model.headerRowCount);
	if (index < headerCount || index >= model.rows.length) return model;
	const rows = model.rows.slice();
	rows.splice(index, 1);
	return { ...model, rows };
}

/** Removes the column at `index`, from every row and from the alignment list. */
export function deleteColumn(model: TableEditModel, index: number): TableEditModel {
	const width = model.align.length || model.rows[0]?.length || 0;
	// A table needs at least one column; removing the last would leave `||`.
	if (width <= 1 || index < 0 || index >= width) return model;
	const rows = model.rows.map((cells) => {
		const next = cells.slice();
		next.splice(index, 1);
		return next;
	});
	const align = model.align.slice();
	align.splice(index, 1);
	return { ...model, rows, align };
}
