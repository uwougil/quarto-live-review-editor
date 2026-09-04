import { forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { viewportParsingDisabledForTest } from './debug';

// Parsing only to the current viewport is important here. Calling
// forceParsing(..., state.doc.length) would turn a scroll into a full-document
// parse and would make large papers feel unresponsive. The timeout is a small
// per-pass budget; if a long region still isn't available, the next scheduled
// pass continues from the parser's existing fragments.
const PARSE_TIMEOUT_MS = 24;

function parseViewport(view: EditorView): void {
	if (viewportParsingDisabledForTest()) return;
	if (!view.dom.isConnected) return;
	const target = Math.min(view.viewport.to, view.state.doc.length);
	if (syntaxTreeAvailable(view.state, target)) return;
	forceParsing(view, target, PARSE_TIMEOUT_MS);
}

export const viewportSyntaxPlugin = ViewPlugin.fromClass(
	class {
		private timer: ReturnType<typeof setTimeout> | undefined;
		private scheduledTarget = -1;

		constructor(view: EditorView) {
			this.schedule(view);
		}

		update(update: ViewUpdate): void {
			if (
				update.docChanged ||
				update.viewportChanged ||
				syntaxTree(update.startState) !== syntaxTree(update.state)
			) {
				this.schedule(update.view);
			}
		}

		private schedule(view: EditorView): void {
			if (viewportParsingDisabledForTest()) return;
			const target = Math.min(view.viewport.to, view.state.doc.length);
			if (syntaxTreeAvailable(view.state, target)) return;
			// A single viewport change can generate several layout/parse updates. Keep
			// at most one pending pass, but allow a later, farther viewport to replace
			// the earlier target.
			if (this.timer !== undefined && target <= this.scheduledTarget) return;
			if (this.timer !== undefined) clearTimeout(this.timer);
			this.scheduledTarget = target;
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.scheduledTarget = -1;
				parseViewport(view);
				// forceParsing dispatches a state-only transaction when it advances the
				// tree. If it ran out of its small budget without reaching the viewport,
				// keep making bounded passes until the viewport is available.
				if (view.dom.isConnected && !syntaxTreeAvailable(view.state, view.viewport.to)) {
					this.schedule(view);
				}
			}, 0);
		}

		destroy(): void {
			if (this.timer !== undefined) clearTimeout(this.timer);
		}
	},
);
