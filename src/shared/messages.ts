import type { HeadingItem } from './headings';
import type { DocumentDialect } from '../quarto/dialect';

export interface TextChange {
	from: number;
	to: number;
	insert: string;
}

export interface CodeToken {
	from: number;
	to: number;
	style: string;
}

export interface CodeBlockTokens {
	from: number;
	to: number;
	tokens: CodeToken[];
}

export type HostToEditorMessage =
	// `baseUri` is the webview-loadable URI (with a trailing slash) of the
	// folder containing the document, used to resolve relative image paths
	// (e.g. `assets/foo.png`) to something the webview is actually allowed to load.
	| { type: 'init'; text: string; version: number; css: string; codeTheme: string; baseUri: string; dialect: DocumentDialect }
	| { type: 'externalUpdate'; changes: TextChange[]; version: number }
	| { type: 'ackEdit'; version: number }
	| { type: 'codeTokens'; blocks: CodeBlockTokens[] }
	| { type: 'applyCss'; css: string }
	| { type: 'jumpToLine'; line: number }
	// Reply to `readDrawioFile`. `text` is the file's contents, or `error` says
	// why it could not be read; exactly one of the two is set. `requestId`
	// matches the reply to the widget that asked, since several diagrams in one
	// document can have requests in flight at the same time.
	| { type: 'drawioFile'; requestId: number; text?: string; error?: string }
	| { type: 'setCursor'; pos: number };

export type EditorToHostMessage =
	| { type: 'ready' }
	| { type: 'edit'; baseVersion: number; changes: TextChange[] }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'openLink'; href: string }
	| { type: 'pasteImage'; atPos: number; mimeType: string; dataBase64: string; needsOwnParagraph: boolean }
	// A `![](diagram.drawio)` reference: the webview cannot read workspace files
	// itself, and an <img> cannot render mxGraph XML, so the host reads the file
	// and sends its text back for the widget to parse. `src` is the raw, relative
	// path exactly as written in the Markdown; the host resolves it.
	| { type: 'readDrawioFile'; requestId: number; src: string };

export interface StyleEntry {
	id: string;
	name: string;
	enabled: boolean;
	/** Raw CSS content, used by the sidebar to render a live preview thumbnail. */
	css: string;
}

/** The extension settings the sidebar surfaces and can change. */
export interface SidebarSettings {
	defaultEditor: string;
	codeTheme: string;
}

/** Which VS Code theme is active, so previews gate `body.vscode-*` rules correctly. */
export type ThemeKind = 'vscode-light' | 'vscode-dark' | 'vscode-high-contrast';

export type HostToSidebarMessage = {
	type: 'init';
	styles: StyleEntry[];
	settings: SidebarSettings;
	themeKind: ThemeKind;
};

export type SidebarToHostMessage =
	| { type: 'ready' }
	| { type: 'toggle'; id: string; enabled: boolean }
	| { type: 'newStyle' }
	| { type: 'openStyle'; id: string }
	| { type: 'duplicateStyle'; id: string }
	| { type: 'renameStyle'; id: string }
	| { type: 'deleteStyle'; id: string }
	| { type: 'setSetting'; key: keyof SidebarSettings; value: string };

// Live CSS-theme preview panel (opened beside the CSS file while editing it).
export type HostToPreviewMessage =
	| { type: 'update'; css: string; themeKind: ThemeKind; name: string }
	// Glow the preview elements matching the selector of the rule under the cursor
	// (null clears the highlight).
	| { type: 'highlight'; selector: string | null };
export type PreviewToHostMessage = { type: 'ready' };

// Outline (heading list) sidebar view.
export type HostToOutlineMessage =
	| { type: 'update'; headings: HeadingItem[] }
	// No Markdown Live Preview panel is currently active (none open, or focus
	// moved away from any of them).
	| { type: 'noDocument' };

export type OutlineToHostMessage = { type: 'ready' } | { type: 'jumpToHeading'; line: number };
