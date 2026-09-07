import { describe, expect, it } from 'vitest';
import { reconcileEditorAssociations, type EditorAssociationState } from './editorAssociations';

const VIEW_TYPE = 'mdLivePreview.editor';

function step(current: Record<string, unknown>, mode: 'prompt' | 'livePreview' | 'default', state?: EditorAssociationState) {
	return reconcileEditorAssociations(current, mode, VIEW_TYPE, state);
}

describe('reconcileEditorAssociations', () => {
	it('manages associations when none existed and restores absence in prompt mode', () => {
		const enabled = step({}, 'livePreview');
		expect(enabled.associations).toEqual({ '*.md': VIEW_TYPE, '*.qmd': VIEW_TYPE });
		expect(step(enabled.associations, 'prompt', enabled.state).associations).toEqual({});
	});

	it('restores pre-existing md and qmd associations exactly', () => {
		const original = { '*.md': 'other.md', '*.qmd': 'other.qmd', '*.txt': 'default' };
		const enabled = step(original, 'livePreview');
		expect(step(enabled.associations, 'prompt', enabled.state).associations).toEqual(original);
	});

	it('preserves a user change made while the extension owns an association', () => {
		const enabled = step({ '*.md': 'old-editor' }, 'livePreview');
		const userChanged = { ...enabled.associations, '*.md': 'new-user-editor' };
		const restored = step(userChanged, 'prompt', enabled.state);
		expect(restored.associations['*.md']).toBe('new-user-editor');
		expect(restored.associations).not.toHaveProperty('*.qmd');
	});

	it('keeps the original values across livePreview/default/livePreview/prompt transitions', () => {
		const original = { '*.md': 'custom' };
		const live = step(original, 'livePreview');
		const plain = step(live.associations, 'default', live.state);
		expect(plain.associations).toMatchObject({ '*.md': 'default', '*.qmd': 'default' });
		const liveAgain = step(plain.associations, 'livePreview', plain.state);
		expect(step(liveAgain.associations, 'prompt', liveAgain.state).associations).toEqual(original);
	});
});

