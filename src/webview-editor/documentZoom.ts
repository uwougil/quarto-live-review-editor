import {
	adjustDocumentZoom,
	DOCUMENT_ZOOM_DEFAULT,
	normalizeDocumentZoom,
	adjustReadingWidth,
	READING_WIDTH_DEFAULT,
	READING_WIDTH_FULL,
	READING_WIDTH_MAX,
	READING_WIDTH_MIN,
	READING_WIDTH_STEP,
	type ReadingWidthState,
	normalizeReadingWidth,
} from '../shared/documentZoom';

export type DocumentZoomChange = (percent: number) => void;
export type ReadingWidthChange = (state: ReadingWidthState) => void;

interface ZoomControllerOptions {
	initialPercent?: unknown;
	onChange?: DocumentZoomChange;
	initialReadingWidthPercent?: unknown;
	onReadingWidthChange?: ReadingWidthChange;
	onApplied?: () => void;
	/** Supplied explicitly by tests; production uses the current browser platform. */
	platform?: string;
}

export type ZoomKeyAction = 'reset' | 'increaseWidth' | 'decreaseWidth' | 'resetWidth';

export interface ReadingWidthGeometry {
	width: number;
	maxWidth: string;
}

export type ReadingWidthGeometryProbe = (state: ReadingWidthState) => ReadingWidthGeometry | undefined;

const READING_WIDTH_VISUAL_EPSILON = 1;

function isMacPlatform(platform: string): boolean {
	return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function hasPlatformModifier(event: KeyboardEvent | WheelEvent, mac: boolean): boolean {
	return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Returns the zoom direction represented by a wheel delta. */
export function wheelZoomSteps(deltaY: number): number {
	if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
	return deltaY < 0 ? 1 : -1;
}

/**
 * Maps the platform's document-zoom shortcuts to an action. `=` is accepted as
 * well as `+` because browsers report Ctrl/Cmd+Plus differently across keyboard
 * layouts (and the numpad codes cover keyboards without a shifted `=` key).
 */
export function zoomKeyAction(
	event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'> & { shiftKey?: boolean },
	platform: string,
): ZoomKeyAction | null {
	if (event.altKey || !hasPlatformModifier(event as KeyboardEvent, isMacPlatform(platform))) return null;
	if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') return event.shiftKey ? 'resetWidth' : 'reset';
	if (event.key === '+' || event.key === '=' || event.code === 'Equal' || event.code === 'NumpadAdd') return 'increaseWidth';
	if (!event.shiftKey && (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract')) return 'decreaseWidth';
	return null;
}

function geometryChanged(a: ReadingWidthGeometry, b: ReadingWidthGeometry): boolean {
	return Math.abs(a.width - b.width) >= READING_WIDTH_VISUAL_EPSILON;
}

function isAdaptedFiniteStep(a: ReadingWidthGeometry, b: ReadingWidthGeometry): boolean {
	return a.maxWidth !== b.maxWidth;
}

/**
 * Chooses the next reading-width state using the real rendered column geometry.
 *
 * 60–320% remains the persisted numeric state space, but finite-width themes can
 * hit the current viewport before 320%. In that case invisible numeric steps are
 * skipped: increasing enters Full as soon as the next step would reach/saturate
 * the viewport, while decreasing searches backward for the first numeric step
 * that visibly narrows the column. Unsupported/custom width rules keep the old
 * purely numeric behavior because their computed max-width does not respond to
 * the Live Preview scale variable.
 */
export function adjustReadingWidthForVisualGeometry(
	current: unknown,
	steps: number,
	probe: ReadingWidthGeometryProbe,
): ReadingWidthState {
	const base = normalizeReadingWidth(current);
	if (!Number.isFinite(steps) || steps === 0) return base;
	const direction = Math.sign(Math.trunc(steps));
	if (direction === 0) return base;

	if (direction > 0) {
		if (base === READING_WIDTH_FULL) return READING_WIDTH_FULL;
		const next = adjustReadingWidth(base, 1);
		if (next === READING_WIDTH_FULL) return READING_WIDTH_FULL;

		const currentGeometry = probe(base);
		const nextGeometry = probe(next);
		if (!currentGeometry || !nextGeometry || !isAdaptedFiniteStep(currentGeometry, nextGeometry)) {
			return next;
		}

		const fullGeometry = probe(READING_WIDTH_FULL);
		if (!geometryChanged(currentGeometry, nextGeometry)) return READING_WIDTH_FULL;
		if (fullGeometry && !geometryChanged(nextGeometry, fullGeometry)) return READING_WIDTH_FULL;
		return next;
	}

	if (base === READING_WIDTH_FULL) {
		const fullGeometry = probe(READING_WIDTH_FULL);
		const maximumGeometry = probe(READING_WIDTH_MAX);
		if (!fullGeometry || !maximumGeometry) return adjustReadingWidth(base, -1);

		const lowerMaximum = READING_WIDTH_MAX - READING_WIDTH_STEP;
		const lowerMaximumGeometry = probe(lowerMaximum);
		if (!lowerMaximumGeometry || !isAdaptedFiniteStep(maximumGeometry, lowerMaximumGeometry)) {
			return READING_WIDTH_MAX;
		}

		for (let candidate = READING_WIDTH_MAX; candidate >= READING_WIDTH_MIN; candidate -= READING_WIDTH_STEP) {
			const candidateGeometry = probe(candidate);
			if (candidateGeometry && geometryChanged(fullGeometry, candidateGeometry)) return candidate;
		}
		// The viewport is narrower than even the minimum numeric cap, so no
		// decrement can produce a visible change. Keep Full rather than silently
		// accumulating an invisible numeric state.
		return READING_WIDTH_FULL;
	}

	const immediate = adjustReadingWidth(base, -1);
	if (typeof immediate !== 'number' || immediate === base) return immediate;
	const currentGeometry = probe(base);
	const immediateGeometry = probe(immediate);
	if (!currentGeometry || !immediateGeometry || !isAdaptedFiniteStep(currentGeometry, immediateGeometry)) {
		return immediate;
	}
	if (geometryChanged(currentGeometry, immediateGeometry)) return immediate;

	for (let candidate = immediate - READING_WIDTH_STEP; candidate >= READING_WIDTH_MIN; candidate -= READING_WIDTH_STEP) {
		const candidateGeometry = probe(candidate);
		if (candidateGeometry && geometryChanged(currentGeometry, candidateGeometry)) return candidate;
	}
	// As above, avoid changing only the hidden state when the viewport physically
	// cannot become any narrower through this finite max-width scale.
	return base;
}

/**
 * Owns the event boundary for document typography zoom and reading width. The
 * listener lives under the editor root, so other VS Code webviews never see
 * these events. It checks the active element before intercepting anything,
 * which preserves normal browser and panel behaviour when Live Preview is not
 * focused.
 */
export class DocumentZoomController {
	private percent: number;
	private readingWidthPercent: ReadingWidthState;
	private readonly mac: boolean;
	private readonly onWheel: (event: WheelEvent) => void;
	private readonly onKeydown: (event: KeyboardEvent) => void;

	constructor(
		private readonly root: HTMLElement,
		private readonly options: ZoomControllerOptions = {},
	) {
		this.percent = normalizeDocumentZoom(options.initialPercent ?? DOCUMENT_ZOOM_DEFAULT);
		this.readingWidthPercent = normalizeReadingWidth(options.initialReadingWidthPercent ?? READING_WIDTH_DEFAULT);
		const platform = options.platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform);
		this.mac = isMacPlatform(platform);
		this.applyCss();

		this.onWheel = (event) => {
			if (event.defaultPrevented || !this.isFocused() || !hasPlatformModifier(event, this.mac)) return;
			const steps = wheelZoomSteps(event.deltaY);
			if (steps === 0) return;
			// Prevent the browser/webview page zoom even when the document is already
			// at a boundary. A boundary press is still a handled Live Preview action.
			event.preventDefault();
			this.changeTypography(steps);
		};
		this.onKeydown = (event) => {
			if (event.defaultPrevented || !this.isFocused()) return;
			const action = zoomKeyAction(event, platform);
			if (!action) return;
			event.preventDefault();
			event.stopPropagation();
			switch (action) {
				case 'reset':
					this.setPercent(DOCUMENT_ZOOM_DEFAULT);
					break;
				case 'increaseWidth':
					this.changeReadingWidth(1);
					break;
				case 'decreaseWidth':
					this.changeReadingWidth(-1);
					break;
				case 'resetWidth':
					this.setReadingWidthPercent(READING_WIDTH_DEFAULT);
					break;
			}
		};

		this.root.addEventListener('wheel', this.onWheel, { passive: false });
		this.root.addEventListener('keydown', this.onKeydown, true);
	}

	get percentValue(): number {
		return this.percent;
	}

	get readingWidthPercentValue(): ReadingWidthState {
		return this.readingWidthPercent;
	}

	setPercent(value: unknown): void {
		this.setPercentInternal(normalizeDocumentZoom(value), false);
	}

	setReadingWidthPercent(value: unknown): void {
		this.setReadingWidthInternal(normalizeReadingWidth(value), false);
	}

	dispose(): void {
		this.root.removeEventListener('wheel', this.onWheel);
		this.root.removeEventListener('keydown', this.onKeydown, true);
	}

	private isFocused(): boolean {
		const active = this.root.ownerDocument.activeElement;
		return active === this.root || this.root.contains(active);
	}

	private changeTypography(steps: number): void {
		this.setPercentInternal(adjustDocumentZoom(this.percent, steps), true);
	}

	private changeReadingWidth(steps: number): void {
		const next = adjustReadingWidthForVisualGeometry(
			this.readingWidthPercent,
			steps,
			(state) => this.probeReadingWidthGeometry(state),
		);
		this.setReadingWidthInternal(next, true);
	}

	private setPercentInternal(next: number, notify: boolean): void {
		if (next === this.percent) {
			// Boundary actions still need the browser default cancelled, but there is
			// no layout work to repeat when the value is unchanged.
			return;
		}
		this.percent = next;
		this.applyCss();
		this.notifyApplied();
		if (notify) this.optionsOnChange?.(next);
	}

	private notifyApplied(): void {
		if (!this.optionsOnApplied) return;
		const window = this.root.ownerDocument.defaultView;
		if (window?.requestAnimationFrame) window.requestAnimationFrame(() => this.optionsOnApplied?.());
		else this.optionsOnApplied();
	}

	private setReadingWidthInternal(next: ReadingWidthState, notify: boolean): void {
		if (next === this.readingWidthPercent) return;
		this.readingWidthPercent = next;
		this.applyCss();
		this.notifyApplied();
		if (notify) this.optionsOnReadingWidthChange?.(next);
	}

	private probeReadingWidthGeometry(state: ReadingWidthState): ReadingWidthGeometry | undefined {
		const content = this.root.querySelector<HTMLElement>('.cm-content');
		const window = this.root.ownerDocument.defaultView;
		if (!content || !window) return undefined;

		// Temporarily apply the candidate inside the same JS task, force layout by
		// reading the rect/computed style, then restore the real state before the
		// browser can paint. This makes the boundary responsive to viewport,
		// sidebar/split width and theme baseline without persisting probe states.
		this.applyReadingWidthCss(state);
		const geometry = {
			width: content.getBoundingClientRect().width,
			maxWidth: window.getComputedStyle(content).maxWidth,
		};
		this.applyReadingWidthCss(this.readingWidthPercent);
		return geometry;
	}

	private applyCss(): void {
		this.root.style.setProperty('--mlp-document-zoom', String(this.percent / 100));
		this.applyReadingWidthCss(this.readingWidthPercent);
	}

	private applyReadingWidthCss(state: ReadingWidthState): void {
		const isFull = state === READING_WIDTH_FULL;
		const readingWidthPercent = isFull ? READING_WIDTH_MAX : state;
		this.root.style.setProperty('--mlp-reading-width', String(readingWidthPercent / 100));
		if (isFull) {
			// This variable is consumed only by finite max-width declarations that
			// cssAdapter has proven to be the reading column. Unsupported/custom
			// selectors never see a Full override.
			this.root.style.setProperty('--mlp-reading-column-max-width', 'none');
			this.root.dataset.mlpReadingWidth = READING_WIDTH_FULL;
		} else {
			this.root.style.removeProperty('--mlp-reading-column-max-width');
			this.root.dataset.mlpReadingWidth = String(state);
		}
	}

	private get optionsOnChange(): DocumentZoomChange | undefined {
		return this.options.onChange;
	}

	private get optionsOnReadingWidthChange(): ReadingWidthChange | undefined {
		return this.options.onReadingWidthChange;
	}

	private get optionsOnApplied(): (() => void) | undefined {
		return this.options.onApplied;
	}
}
