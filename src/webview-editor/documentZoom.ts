import {
	adjustDocumentZoom,
	DOCUMENT_ZOOM_DEFAULT,
	normalizeDocumentZoom,
} from '../shared/documentZoom';

export type DocumentZoomChange = (percent: number) => void;

interface ZoomControllerOptions {
	initialPercent?: unknown;
	onChange?: DocumentZoomChange;
	onApplied?: () => void;
	/** Supplied explicitly by tests; production uses the current browser platform. */
	platform?: string;
}

type ZoomKeyAction = 'increase' | 'decrease' | 'reset';

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
export function zoomKeyAction(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>, platform: string): ZoomKeyAction | null {
	if (event.altKey || !hasPlatformModifier(event as KeyboardEvent, isMacPlatform(platform))) return null;
	if (event.key === '0' || event.code === 'Numpad0') return 'reset';
	if (event.key === '+' || event.key === '=' || event.code === 'Equal' || event.code === 'NumpadAdd') return 'increase';
	if (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract') return 'decrease';
	return null;
}

/**
 * Owns the event boundary for document zoom. The listener lives under the
 * editor root, so other VS Code webviews never see these events. It checks the
 * active element before intercepting anything, which preserves normal browser
 * and panel behaviour when the Live Preview is not focused.
 */
export class DocumentZoomController {
	private percent: number;
	private readonly mac: boolean;
	private readonly onWheel: (event: WheelEvent) => void;
	private readonly onKeydown: (event: KeyboardEvent) => void;

	constructor(
		private readonly root: HTMLElement,
		private readonly options: ZoomControllerOptions = {},
	) {
		this.percent = normalizeDocumentZoom(options.initialPercent ?? DOCUMENT_ZOOM_DEFAULT);
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
			this.change(steps);
		};
		this.onKeydown = (event) => {
			if (event.defaultPrevented || !this.isFocused()) return;
			const action = zoomKeyAction(event, platform);
			if (!action) return;
			event.preventDefault();
			event.stopPropagation();
			if (action === 'reset') this.setPercent(DOCUMENT_ZOOM_DEFAULT);
			else this.change(action === 'increase' ? 1 : -1);
		};

		this.root.addEventListener('wheel', this.onWheel, { passive: false });
		this.root.addEventListener('keydown', this.onKeydown, true);
	}

	get percentValue(): number {
		return this.percent;
	}

	setPercent(value: unknown): void {
		this.setPercentInternal(normalizeDocumentZoom(value), false);
	}

	dispose(): void {
		this.root.removeEventListener('wheel', this.onWheel);
		this.root.removeEventListener('keydown', this.onKeydown, true);
	}

	private isFocused(): boolean {
		const active = this.root.ownerDocument.activeElement;
		return active === this.root || this.root.contains(active);
	}

	private change(steps: number): void {
		this.setPercentInternal(adjustDocumentZoom(this.percent, steps), true);
	}

	private setPercentInternal(next: number, notify: boolean): void {
		if (next === this.percent) {
			// Boundary actions still need the browser default cancelled, but there is
			// no layout work to repeat when the value is unchanged.
			return;
		}
		this.percent = next;
		this.applyCss();
		if (this.optionsOnApplied) {
			const window = this.root.ownerDocument.defaultView;
			if (window?.requestAnimationFrame) window.requestAnimationFrame(() => this.optionsOnApplied?.());
			else this.optionsOnApplied();
		}
		if (notify) this.optionsOnChange?.(next);
	}

	private applyCss(): void {
		this.root.style.setProperty('--mlp-document-zoom', String(this.percent / 100));
	}

	private get optionsOnChange(): DocumentZoomChange | undefined {
		return this.options.onChange;
	}

	private get optionsOnApplied(): (() => void) | undefined {
		return this.options.onApplied;
	}
}
