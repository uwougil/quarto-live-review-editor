import type { EditorView, ViewUpdate } from '@codemirror/view';
import { DEFAULT_TYPEWRITER_MODE, TYPEWRITER_TARGET_RATIO } from '../shared/typewriterMode';

export { DEFAULT_TYPEWRITER_MODE, TYPEWRITER_TARGET_RATIO } from '../shared/typewriterMode';

export const POINTER_DRAG_THRESHOLD_PX = 5;

export interface TypewriterScrollMetrics {
	currentScrollTop: number;
	clientHeight: number;
	scrollHeight: number;
	viewportTop: number;
	caretTop: number;
	caretBottom: number;
}

/** Returns whether a pointer moved far enough to be treated as a drag. */
export function hasPointerMovedBeyondDragThreshold(
	startX: number,
	startY: number,
	currentX: number,
	currentY: number,
	threshold = POINTER_DRAG_THRESHOLD_PX,
): boolean {
	return Math.hypot(currentX - startX, currentY - startY) > threshold;
}

/**
 * Returns the scrollTop that puts the caret's vertical midpoint at the target
 * ratio of the scroll viewport. Clamping is what makes the first and last
 * lines behave naturally when the target zone cannot be reached.
 */
export function calculateTypewriterScrollTop(
	metrics: TypewriterScrollMetrics,
	targetRatio = TYPEWRITER_TARGET_RATIO,
): number {
	if (metrics.clientHeight <= 0 || metrics.scrollHeight <= metrics.clientHeight) {
		return metrics.currentScrollTop;
	}

	const caretCenter = (metrics.caretTop + metrics.caretBottom) / 2;
	const caretDocumentY = metrics.currentScrollTop + caretCenter - metrics.viewportTop;
	const desired = caretDocumentY - metrics.clientHeight * targetRatio;
	const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
	return Math.max(0, Math.min(maxScrollTop, desired));
}

/** Whether a key represents an intentional writing/navigation interaction. */
export function isWritingOrientedKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
	if (event.ctrlKey || event.metaKey || event.altKey) return false;
	return (
		event.key === 'Enter' ||
		event.key === 'ArrowUp' ||
		event.key === 'ArrowDown' ||
		event.key === 'Backspace' ||
		event.key === 'Delete' ||
		event.key === 'Tab' ||
		event.key.length === 1
	);
}

/**
 * Keeps the active caret near the Typewriter target without taking control of
 * the viewport after a direct mouse or navigation gesture.
 *
 * The controller intentionally owns scrollTop instead of dispatching a
 * `scrollIntoView` transaction. That avoids feeding its own positioning back
 * through CodeMirror's update cycle and lets the target be 50% rather than the
 * usual minimal-reveal/center positions.
 */
export class TypewriterModeController {
	private enabled = DEFAULT_TYPEWRITER_MODE;
	private suspended = true;
	private writingScrollPending = false;
	private scheduledFrame: number | undefined;
	private programmaticScrollTop: number | undefined;
	private pointerGesture: {
		pointerId: number;
		startX: number;
		startY: number;
		target: EventTarget | null;
		dragging: boolean;
	} | undefined;

	private readonly onKeyDown = (event: KeyboardEvent): void => {
		if (!this.isEditorContentTarget(event)) return;
		if (isWritingOrientedKey(event)) this.beginWritingInteraction();
	};

	private readonly onBeforeInput = (event: InputEvent): void => {
		if (!this.isEditorContentTarget(event)) return;
		if (event.inputType.startsWith('insert') || event.inputType.startsWith('delete')) {
			this.beginWritingInteraction();
		}
	};

	private readonly onPasteOrDrop = (event: ClipboardEvent | DragEvent): void => {
		if (!this.isEditorContentTarget(event)) return;
		this.beginWritingInteraction();
	};

	private readonly onMouseDown = (event: MouseEvent): void => {
		if (event.button !== 0) return;
		this.suspendForUserAction();
	};

	private readonly onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) {
			this.suspendForUserAction();
			return;
		}
		this.suspendForUserAction();
		if (!this.isEditorContentTarget(event) || this.isInteractiveWidgetTarget(event.target)) {
			this.pointerGesture = undefined;
			return;
		}
		this.pointerGesture = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			target: event.target,
			dragging: false,
		};
		try {
			this.view.dom.setPointerCapture(event.pointerId);
		} catch {
			// Pointer capture is a convenience for drags that leave the editor;
			// browsers that reject it still get the threshold discrimination.
		}
	};

	private readonly onPointerMove = (event: PointerEvent): void => {
		const gesture = this.pointerGesture;
		if (!gesture || gesture.pointerId !== event.pointerId || gesture.dragging) return;
		if (hasPointerMovedBeyondDragThreshold(gesture.startX, gesture.startY, event.clientX, event.clientY)) {
			gesture.dragging = true;
		}
	};

	private readonly onPointerUp = (event: PointerEvent): void => {
		const gesture = this.pointerGesture;
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		this.pointerGesture = undefined;
		try {
			this.view.dom.releasePointerCapture(event.pointerId);
		} catch {
			// The pointer may already have been released by the browser.
		}
		if (
			event.button !== 0 ||
			gesture.dragging ||
			!this.enabled ||
			!this.isEditorContentNode(gesture.target) ||
			!this.view.state.selection.main.empty
		) return;
		// CodeMirror has processed the mousedown selection by pointerup. Schedule
		// one frame so the final caret geometry, including wrapped lines, is real.
		this.beginWritingInteraction();
	};

	private readonly onPointerCancel = (event: PointerEvent): void => {
		if (this.pointerGesture?.pointerId !== event.pointerId) return;
		this.pointerGesture = undefined;
		this.suspendForUserAction();
	};

	private readonly onClick = (event: MouseEvent): void => {
		if (
			event.detail !== 1 ||
			!this.enabled ||
			!this.isEditorContentTarget(event) ||
			this.isInteractiveWidgetTarget(event.target) ||
			!this.view.state.selection.main.empty
		) return;
		// This is a fallback for platforms that do not deliver a usable pointerup
		// target. It is coalesced with the pointerup rAF when both are present.
		this.beginWritingInteraction();
	};

	private readonly onWheel = (): void => {
		this.suspendForUserAction();
	};

	private readonly onScroll = (): void => {
		const scrollTop = this.view.scrollDOM.scrollTop;
		if (this.programmaticScrollTop !== undefined) {
			const wasOurScroll = Math.abs(scrollTop - this.programmaticScrollTop) <= 1;
			this.programmaticScrollTop = undefined;
			if (wasOurScroll) return;
		}
		// CodeMirror's own minimal-reveal scroll can happen before our rAF. It is
		// part of the same keyboard interaction, not a manual scroll to respect.
		if (this.writingScrollPending) return;
		this.suspendForUserAction();
	};

	constructor(private readonly view: EditorView) {
		// Capture on the editor root so clicks on rendered widgets and the native
		// scrollbar are treated as user-owned viewport changes as well.
		this.view.dom.addEventListener('keydown', this.onKeyDown, true);
		this.view.dom.addEventListener('beforeinput', this.onBeforeInput, true);
		this.view.dom.addEventListener('paste', this.onPasteOrDrop, true);
		this.view.dom.addEventListener('drop', this.onPasteOrDrop, true);
		this.view.scrollDOM.addEventListener('mousedown', this.onMouseDown, true);
		this.view.scrollDOM.addEventListener('pointerdown', this.onPointerDown, true);
		this.view.dom.addEventListener('pointermove', this.onPointerMove, true);
		this.view.dom.addEventListener('pointerup', this.onPointerUp, true);
		this.view.dom.addEventListener('pointercancel', this.onPointerCancel, true);
		this.view.dom.addEventListener('click', this.onClick, true);
		this.view.scrollDOM.addEventListener('wheel', this.onWheel, { capture: true, passive: true });
		this.view.scrollDOM.addEventListener('scroll', this.onScroll);
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		this.cancelScheduledPositioning();
		this.programmaticScrollTop = undefined;
		// Turning the mode on does not jump the document. The next writing
		// interaction establishes the target, which keeps a setting change from
		// unexpectedly moving a document the user is currently inspecting.
		this.suspended = true;
	}

	/** Call before a host-driven jump or other explicit navigation. */
	suspendForNavigation(): void {
		this.suspendForUserAction();
	}

	/** Called from the editor update listener after a local, non-remote update. */
	onUpdate(update: ViewUpdate): void {
		if (!this.enabled) return;
		if (update.docChanged && update.transactions.some((transaction) => transaction.isUserEvent('input'))) {
			this.beginWritingInteraction();
		}
	}

	destroy(): void {
		this.cancelScheduledPositioning();
		this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
		this.view.dom.removeEventListener('beforeinput', this.onBeforeInput, true);
		this.view.dom.removeEventListener('paste', this.onPasteOrDrop, true);
		this.view.dom.removeEventListener('drop', this.onPasteOrDrop, true);
		this.view.scrollDOM.removeEventListener('mousedown', this.onMouseDown, true);
		this.view.scrollDOM.removeEventListener('pointerdown', this.onPointerDown, true);
		this.view.dom.removeEventListener('pointermove', this.onPointerMove, true);
		this.view.dom.removeEventListener('pointerup', this.onPointerUp, true);
		this.view.dom.removeEventListener('pointercancel', this.onPointerCancel, true);
		this.view.dom.removeEventListener('click', this.onClick, true);
		this.view.scrollDOM.removeEventListener('wheel', this.onWheel, true);
		this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
	}

	private beginWritingInteraction(): void {
		if (!this.enabled) return;
		this.suspended = false;
		this.writingScrollPending = true;
		this.schedulePositioning();
	}

	private isEditorContentTarget(event: Event): boolean {
		return this.isEditorContentNode(event.target);
	}

	private isEditorContentNode(target: EventTarget | null): target is Node {
		return target instanceof Node && this.view.contentDOM.contains(target);
	}

	private isInteractiveWidgetTarget(target: EventTarget | null): boolean {
		return target instanceof Element && Boolean(
			target.closest('.mlp-link, .mlp-footnote-ref, .mlp-footnote-back, button, a, input, textarea, select, [contenteditable="false"]'),
		);
	}

	private suspendForUserAction(): void {
		if (!this.enabled) return;
		this.suspended = true;
		this.writingScrollPending = false;
		this.programmaticScrollTop = undefined;
		this.cancelScheduledPositioning();
	}

	private schedulePositioning(): void {
		if (this.scheduledFrame !== undefined) return;
		this.scheduledFrame = requestAnimationFrame(() => {
			this.scheduledFrame = undefined;
			this.writingScrollPending = false;
			if (!this.enabled || this.suspended) return;
			this.positionCaret();
		});
	}

	private cancelScheduledPositioning(): void {
		if (this.scheduledFrame === undefined) return;
		cancelAnimationFrame(this.scheduledFrame);
		this.scheduledFrame = undefined;
	}

	private positionCaret(): void {
		const selection = this.view.state.selection.main;
		const caret = this.view.coordsAtPos(selection.head);
		const scrollDOM = this.view.scrollDOM;
		if (!caret || scrollDOM.clientHeight <= 0) return;

		const rect = scrollDOM.getBoundingClientRect();
		const target = calculateTypewriterScrollTop({
			currentScrollTop: scrollDOM.scrollTop,
			clientHeight: scrollDOM.clientHeight,
			scrollHeight: scrollDOM.scrollHeight,
			viewportTop: rect.top,
			caretTop: caret.top,
			caretBottom: caret.bottom,
		});
		if (Math.abs(target - scrollDOM.scrollTop) <= 1) return;
		this.programmaticScrollTop = target;
		scrollDOM.scrollTop = target;
	}
}
