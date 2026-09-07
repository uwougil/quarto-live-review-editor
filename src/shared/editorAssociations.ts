export type DefaultEditorMode = 'prompt' | 'livePreview' | 'default';
export type EditorAssociations = Record<string, unknown>;

interface ManagedAssociation {
	hadOriginal: boolean;
	original?: unknown;
	managed: unknown;
}

export interface EditorAssociationState {
	entries: Partial<Record<'*.md' | '*.qmd', ManagedAssociation>>;
}

export interface EditorAssociationResult {
	associations: EditorAssociations;
	state: EditorAssociationState;
	associationsChanged: boolean;
	stateChanged: boolean;
}

export interface EditorAssociationsInspection {
	globalValue?: EditorAssociations;
	workspaceValue?: EditorAssociations;
	workspaceFolderValue?: EditorAssociations;
	globalLanguageValue?: EditorAssociations;
	workspaceLanguageValue?: EditorAssociations;
	workspaceFolderLanguageValue?: EditorAssociations;
}

const PATTERNS = ['*.md', '*.qmd'] as const;

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

function sameRecord(a: object, b: object): boolean {
	return sameValue(a, b);
}

/**
 * Applies the extension's desired editor association while retaining ownership
 * metadata for only the two keys it manages. If the current value no longer
 * equals the last value written by the extension, that value is treated as a
 * newer user choice and is never overwritten during restoration.
 */
export function reconcileEditorAssociations(
	current: EditorAssociations,
	mode: DefaultEditorMode,
	viewType: string,
	previous: EditorAssociationState = { entries: {} },
): EditorAssociationResult {
	const associations = { ...current };
	const state: EditorAssociationState = { entries: { ...previous.entries } };
	const desired = mode === 'livePreview' ? viewType : mode === 'default' ? 'default' : undefined;

	for (const pattern of PATTERNS) {
		let entry = state.entries[pattern];
		const currentHas = hasOwn(associations, pattern);
		const currentValue = associations[pattern];

		if (entry && (!currentHas || !sameValue(currentValue, entry.managed))) {
			entry = { ...entry, hadOriginal: currentHas, original: currentValue };
			state.entries[pattern] = entry;
		}

		if (desired !== undefined) {
			if (!entry) {
				entry = { hadOriginal: currentHas, original: currentValue, managed: desired };
			} else {
				entry = { ...entry, managed: desired };
			}
			state.entries[pattern] = entry;
			associations[pattern] = desired;
			continue;
		}

		if (!entry) continue;
		if (currentHas && sameValue(currentValue, entry.managed)) {
			if (entry.hadOriginal) associations[pattern] = entry.original;
			else delete associations[pattern];
		}
		delete state.entries[pattern];
	}

	return {
		associations,
		state,
		associationsChanged: !sameRecord(current, associations),
		stateChanged: !sameRecord(previous, state),
	};
}

/**
 * Reconciles only the user-level value from VS Code configuration inspection.
 * The effective value may also contain workspace, workspace-folder, and
 * language-specific associations, none of which belong in a Global update.
 */
export function reconcileInspectedEditorAssociations(
	inspection: EditorAssociationsInspection | undefined,
	mode: DefaultEditorMode,
	viewType: string,
	previous?: EditorAssociationState,
): EditorAssociationResult {
	return reconcileEditorAssociations(inspection?.globalValue ?? {}, mode, viewType, previous);
}

