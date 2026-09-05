import { EditorState, Annotation, type Extension, ChangeSet } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from './gfmTableFix';
import { livePreviewPlugin, lineDecorationsField, createLinkClickHandler, setImageBaseUri } from './livePreviewPlugin';
import { codeHighlightExtension, setCodeTokens } from './codeHighlightPlugin';
import { blockDecorationsField, dragReleaseRefresh } from './blockDecorations';
import { detectFrontmatter } from './frontmatterWidget';
import { headingSpaceInputHandler } from './headingSpacePlugin';
import { backtickInputHandler } from './backtickPairPlugin';
import { toggleEmphasisCommand } from './emphasisShortcuts';
import { createImagePasteHandler } from './imagePasteHandler';
import { postToHost, onHostMessage } from './vscodeApi';
import { setDrawioFilePoster, handleDrawioFileMessage, clearDrawioFileCache } from './drawioFileClient';
import { adaptMarkdownCss } from '../shared/cssAdapter';
import type { TextChange } from '../shared/messages';
import { documentDialect, type DocumentDialect } from '../quarto/dialect';
import { mathRangesField } from '../quarto/math';
import { installDebugView } from './debug';
import { viewportSyntaxPlugin } from './viewportSyntax';
import { mathDecorationsField } from './mathDecorations';
import { footnoteIndexField, footnoteNavigationField } from './footnotes';

const remoteChange = Annotation.define<boolean>();
const FLUSH_DEBOUNCE_MS = 250;

let view: EditorView | undefined;
let baseVersion = 0;
let pending: ChangeSet | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function requestMeasureAfterLayout(): void {
	const target = view;
	if (!target) return;
	// A stylesheet mutation and a new EditorView can both happen before the
	// browser has performed layout. Ask CodeMirror to run its supported measure
	// pass after the browser has committed the new style and DOM boxes.
	requestAnimationFrame(() => {
		if (target.dom.isConnected) target.requestMeasure();
	});
}

function flush() {
	flushTimer = undefined;
	if (!view || !pending || pending.empty) {
		pending = null;
		return;
	}
	const changes: TextChange[] = [];
	pending.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		changes.push({ from: fromA, to: toA, insert: inserted.toString() });
	});
	pending = null;
	postToHost({ type: 'edit', baseVersion, changes });
}

function scheduleFlush() {
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
}

function flushNow() {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = undefined;
	}
	flush();
}

function applyUserCss(css: string) {
	let styleEl = document.getElementById('mlp-user-css') as HTMLStyleElement | null;
	if (!styleEl) {
		styleEl = document.createElement('style');
		styleEl.id = 'mlp-user-css';
		document.head.appendChild(styleEl);
	}
	styleEl.textContent = adaptMarkdownCss(css);
	// The stylesheet mutation changes the measured width/height of existing
	// `.cm-line` boxes. CodeMirror's height map is not notified by a style-tag
	// mutation on its own, so schedule its supported measurement pass after the
	// new rules have entered the document.
	requestMeasureAfterLayout();
}

function createExtensions(dialect: DocumentDialect): Extension[] {
	const markdownSupport = markdown({ extensions: GFM });
	return [
		documentDialect.of(dialect),
		mathRangesField,
		mathDecorationsField,
		footnoteIndexField,
		footnoteNavigationField,
		markdownSupport,
		viewportSyntaxPlugin,
		lineDecorationsField,
		// Extend closeBrackets' default pair set (`( [ { ' "`) with the emphasis
		// marks so `*bold/italic*` and `_italic_` also auto-pair and wrap a
		// selection when typed — the same mechanism VS Code and most editors use
		// for quotes. Backtick is deliberately left out here: it's handled by its
		// own `backtickInputHandler` below (see that file for why).
		markdownSupport.language.data.of({ closeBrackets: { brackets: ['(', '[', '{', "'", '"', '*', '_'] } }),
		closeBrackets(),
		headingSpaceInputHandler,
		backtickInputHandler,
		livePreviewPlugin,
		blockDecorationsField,
		dragReleaseRefresh,
		codeHighlightExtension,
		createLinkClickHandler((href) => postToHost({ type: 'openLink', href })),
		createImagePasteHandler((atPos, mimeType, dataBase64, needsOwnParagraph) =>
			postToHost({ type: 'pasteImage', atPos, mimeType, dataBase64, needsOwnParagraph }),
		),
		keymap.of([
			...closeBracketsKeymap,
			// Flush any not-yet-sent keystrokes before asking the host to undo/redo —
			// otherwise the host's document is missing the latest edits when it acts,
			// undoing the wrong change and leaving the webview's local text duplicated
			// relative to what ends up in the file.
			{ key: 'Mod-z', run: () => { flushNow(); postToHost({ type: 'undo' }); return true; } },
			{ key: 'Mod-y', run: () => { flushNow(); postToHost({ type: 'redo' }); return true; } },
			{ key: 'Mod-Shift-z', run: () => { flushNow(); postToHost({ type: 'redo' }); return true; } },
			{ key: 'Mod-b', run: toggleEmphasisCommand('**') },
			{ key: 'Mod-i', run: toggleEmphasisCommand('*') },
			indentWithTab,
			...defaultKeymap,
		]),
		EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			const isRemote = update.transactions.some((tr) => tr.annotation(remoteChange));
			if (isRemote) return;
			pending = pending ? pending.compose(update.changes) : update.changes;
			scheduleFlush();
		}),
		EditorView.domEventHandlers({
			blur: () => flushNow(),
		}),
		EditorView.lineWrapping,
	];
}

// A fresh EditorState's selection defaults to position 0 — i.e. line 1 — which
// is exactly where a leading frontmatter block's own range starts. Left as-is,
// `cursorTouchesLineRange` would read that default as "the cursor is touching the
// frontmatter block" and keep it as raw source on every load, never rendering
// the table until the user happened to move the cursor away first. Placing the
// initial selection just past the block (only when one is actually present)
// avoids that without touching the general cursor-reveals-source behavior.
// `fm.to` is the *end of the closing "---" line itself* (correct for the
// decoration range), so it's still on that line — the anchor must go one
// further, past its line break, to actually land outside the block.
function initialStateFor(text: string, dialect: DocumentDialect): EditorState {
	const state = EditorState.create({ doc: text, extensions: createExtensions(dialect) });
	const fm = detectFrontmatter(state);
	if (!fm) return state;
	const anchor = Math.min(fm.to + 1, state.doc.length);
	return state.update({ selection: { anchor } }).state;
}

function createView(text: string, dialect: DocumentDialect) {
	const root = document.getElementById('mlp-root')!;
	view = new EditorView({
		state: initialStateFor(text, dialect),
		parent: root,
	});
	installDebugView(view);
	// The initial stylesheet is installed before the view exists. The first
	// EditorView measurement can therefore observe the pre-editor layout while
	// line decorations and the content column are still entering the DOM. Queue
	// one supported CodeMirror measurement after construction so its height map
	// and height oracle agree with the final styled `.cm-line` boxes.
	requestMeasureAfterLayout();
}

function resetView(text: string, dialect: DocumentDialect) {
	if (!view) {
		createView(text, dialect);
		return;
	}
	pending = null;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = undefined;
	}
	view.setState(initialStateFor(text, dialect));
}

// The drawio file client cannot reach the host on its own (it is imported by
// widget code that has no business acquiring the VS Code API); hand it the
// poster this module already owns.
setDrawioFilePoster((message) => postToHost(message as Parameters<typeof postToHost>[0]));

onHostMessage((message) => {
	// `drawioFile` replies are routed to whichever widget requested them, not
	// handled by the switch below.
	if (handleDrawioFileMessage(message)) return;
	switch (message.type) {
		case 'init':
			baseVersion = message.version;
			setImageBaseUri(message.baseUri);
			applyUserCss(message.css);
			// A re-init means a different document (or the same one reloaded), so
			// files read for the previous one must not be served from cache.
			clearDrawioFileCache();
			resetView(message.text, message.dialect);
			break;
		case 'ackEdit':
			baseVersion = message.version;
			break;
		case 'externalUpdate': {
			if (!view) return;
			pending = null;
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = undefined;
			}
			view.dispatch({
				changes: message.changes,
				annotations: remoteChange.of(true),
			});
			baseVersion = message.version;
			break;
		}
		case 'codeTokens':
			view?.dispatch({ effects: setCodeTokens.of(message.blocks), annotations: remoteChange.of(true) });
			break;
		case 'applyCss':
			applyUserCss(message.css);
			break;
		case 'jumpToLine': {
			if (!view) return;
			const { doc } = view.state;
			if (message.line < 1 || message.line > doc.lines) return;
			const pos = doc.line(message.line).from;
			view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
			view.focus();
			break;
		}
		case 'setCursor': {
			if (!view) return;
			const pos = Math.max(0, Math.min(message.pos, view.state.doc.length));
			view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
			break;
		}
	}
});

postToHost({ type: 'ready' });
