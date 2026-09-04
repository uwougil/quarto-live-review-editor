import { Facet, type EditorState } from '@codemirror/state';

export type DocumentDialect = 'markdown' | 'quarto';

/** Determines the lightweight syntax dialect from a document path. */
export function documentDialectForPath(path: string): DocumentDialect {
	return /\.qmd$/i.test(path) ? 'quarto' : 'markdown';
}

/** The host supplies this once per webview document. */
export const documentDialect = Facet.define<DocumentDialect, DocumentDialect>({
	combine: (values) => values[0] ?? 'markdown',
});

export function getDocumentDialect(state: EditorState): DocumentDialect {
	return state.facet(documentDialect);
}
