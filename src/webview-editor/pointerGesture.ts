/** Shared click-vs-drag discrimination for rendered inline interactions. */
export interface PointerGestureStart {
	x: number;
	y: number;
}

const DRAG_SLOP_PX = 4;

export function beginPrimaryPointerGesture(event: MouseEvent): PointerGestureStart | null {
	return event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
}

export function isPointerClick(
	start: PointerGestureStart | null,
	event: MouseEvent,
	selectionCollapsed: boolean,
): boolean {
	return Boolean(
		start &&
		event.button === 0 &&
		selectionCollapsed &&
		Math.hypot(event.clientX - start.x, event.clientY - start.y) <= DRAG_SLOP_PX,
	);
}
