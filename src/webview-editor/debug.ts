import { syntaxParserRunning, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { EditorView } from '@codemirror/view';

export interface LivePreviewDebugSnapshot {
	time: number;
	docLength: number;
	docLines: number;
	viewport: { from: number; to: number };
	visibleRanges: Array<{ from: number; to: number }>;
	contentHeight: number;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	domLineCount: number;
	syntaxTreeLength: number;
	syntaxTreeAvailableToViewport: boolean;
	syntaxTreeAvailableToDocument: boolean;
	syntaxParserRunning: boolean;
	decorationRebuildCount: number;
	decorationRebuilds: Array<{ reason: string; durationMs: number; viewportTo: number }>;
}

interface DebugWindow extends Window {
	__MLP_ENABLE_TEST_HOOKS__?: boolean;
	__MLP_DISABLE_VIEWPORT_PARSE_FOR_TEST__?: boolean;
	__mlpDebugSnapshot?: () => LivePreviewDebugSnapshot | null;
	__mlpDebugScrollTo?: (top: number) => void;
	__mlpDebugScrollToPosition?: (pos: number) => void;
	__mlpDebugSelection?: () => { anchor: number; head: number; from: number; to: number; x: number | null; y: number | null; blockFrom: number; blockLength: number; blockTop: number; blockHeight: number; defaultLineHeight: number; contentHeight: number } | null;
	__mlpDebugLineBlock?: (pos: number) => { from: number; length: number; top: number; height: number } | null;
}

let debugView: EditorView | undefined;
const rebuilds: LivePreviewDebugSnapshot['decorationRebuilds'] = [];

export function debugHooksEnabled(): boolean {
	return typeof window !== 'undefined' && (window as DebugWindow).__MLP_ENABLE_TEST_HOOKS__ === true;
}

export function viewportParsingDisabledForTest(): boolean {
	return debugHooksEnabled() && (window as DebugWindow).__MLP_DISABLE_VIEWPORT_PARSE_FOR_TEST__ === true;
}

export function recordDecorationRebuild(reason: string, view: EditorView, durationMs: number): void {
	if (!debugHooksEnabled()) return;
	rebuilds.push({ reason, durationMs, viewportTo: view.viewport.to });
	if (rebuilds.length > 200) rebuilds.splice(0, rebuilds.length - 200);
}

function snapshot(): LivePreviewDebugSnapshot | null {
	if (!debugView) return null;
	const view = debugView;
	const { state } = view;
	const tree = syntaxTree(state);
	return {
		time: performance.now(),
		docLength: state.doc.length,
		docLines: state.doc.lines,
		viewport: { from: view.viewport.from, to: view.viewport.to },
		visibleRanges: view.visibleRanges.map(({ from, to }) => ({ from, to })),
		contentHeight: view.contentHeight,
		scrollTop: view.scrollDOM.scrollTop,
		scrollHeight: view.scrollDOM.scrollHeight,
		clientHeight: view.scrollDOM.clientHeight,
		domLineCount: view.contentDOM.querySelectorAll('.cm-line').length,
		syntaxTreeLength: tree.length,
		syntaxTreeAvailableToViewport: syntaxTreeAvailable(state, view.viewport.to),
		syntaxTreeAvailableToDocument: syntaxTreeAvailable(state, state.doc.length),
		syntaxParserRunning: syntaxParserRunning(view),
		decorationRebuildCount: rebuilds.length,
		decorationRebuilds: rebuilds.slice(),
	};
}

export function installDebugView(view: EditorView): void {
	debugView = view;
	if (!debugHooksEnabled()) return;
	const debugWindow = window as DebugWindow;
	debugWindow.__mlpDebugSnapshot = snapshot;
	debugWindow.__mlpDebugScrollTo = (top) => {
		if (debugView) debugView.scrollDOM.scrollTop = Math.max(0, top);
	};
	debugWindow.__mlpDebugScrollToPosition = (pos) => {
		if (!debugView) return;
		const anchor = Math.max(0, Math.min(pos, debugView.state.doc.length));
		debugView.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
	};
	debugWindow.__mlpDebugSelection = () => {
		if (!debugView) return null;
		const range = debugView.state.selection.main;
		const coords = debugView.coordsAtPos(range.head);
		const block = debugView.lineBlockAt(range.head);
		return { anchor: range.anchor, head: range.head, from: range.from, to: range.to, x: coords?.left ?? null, y: coords?.top ?? null, blockFrom: block.from, blockLength: block.length, blockTop: block.top, blockHeight: block.height, defaultLineHeight: debugView.defaultLineHeight, contentHeight: debugView.contentHeight };
	};
	debugWindow.__mlpDebugLineBlock = (pos) => {
		if (!debugView) return null;
		const block = debugView.lineBlockAt(Math.max(0, Math.min(pos, debugView.state.doc.length)));
		return { from: block.from, length: block.length, top: block.top, height: block.height };
	};
}
