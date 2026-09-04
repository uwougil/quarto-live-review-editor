import * as vscode from 'vscode';
import type { StyleEntry } from '../shared/messages';

const CONFIG_SECTION = 'mdLivePreview';
const ENABLED_STYLES_KEY = 'enabledStyles';

// Bumped whenever the bundled sample set changes; drives a one-time (re)seed so
// existing installs pick up new templates without re-creating ones the user
// later deleted.
const SAMPLES_VERSION = 7;
const SAMPLES_VERSION_KEY = 'mdLivePreview.samplesVersion';
// Bundled samples that were shipped before but are no longer wanted, deleted
// during migration: old `.mlp-*`-selector themes, DADS-light, and Zenn.css.
// The old GitHub names are handled by SAMPLE_RENAMES below so customized files
// are preserved instead of being deleted.
const REMOVED_SAMPLE_NAMES = ['GitHub-like.css', 'Obsidian-like.css', 'DADS-light.css', 'Zenn.css'];
const SAMPLE_RENAMES = [
	{ from: 'github.css', to: 'github-dark.css' },
	{ from: 'github-like.css', to: 'github-dark.css' },
	{ from: 'typora-github.css', to: 'github-light.css' },
] as const;
// Theme selected on a fresh install, and the fallback whenever nothing valid
// is currently enabled (e.g. the previously-enabled theme was just removed by
// a migration below).
const DEFAULT_STYLE_NAME = 'vscode.css';
// Bundled sample themes, shipped as real .css files under media/sample-styles/
// (not embedded as TS strings) so they're easy to review/maintain and can be
// read directly with `vscode.workspace.fs`. Written into global storage once on
// first seed so the user can edit/rename/delete them like any other style file.
const SAMPLE_FILE_NAMES = ['vscode.css', 'dark.css', 'github-light.css', 'claude.css', 'github-dark.css'];

interface StyleFile {
	id: string;
	uri: vscode.Uri;
	name: string;
}

const NEW_STYLE_TEMPLATE = `/*
 * 新建 Quarto Live Review 样式。
 * 可使用与 VS Code Markdown 预览相同的 CSS 格式（HTML 元素选择器）。
 * 例: body, h1〜h6, p, strong, em, a, ul, ol, li, code, pre, blockquote,
 *     table, th, td, hr, img, input[type=checkbox]
 * 如果要覆盖深色主题，请使用 body.vscode-dark 作为前缀。
 */
h1 {
	color: #4493f8;
}
`;

/**
 * Manages the user's CSS theme files. Styles are stored only in the extension's
 * global storage (per-workspace styles were intentionally dropped), and at most
 * one style is active at a time (the sidebar checkboxes behave exclusively).
 */
export class StyleStore {
	private cachedCss = '';
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	private get stylesUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, 'styles');
	}

	async initialize(): Promise<void> {
		await this.ensureSampleStyles();
		this.setupWatchers();
		await this.refresh();
	}

	private async ensureSampleStyles(): Promise<void> {
		// Run the seed/migration once per samples version so we don't fight a user
		// who deleted a sample, while still delivering new templates on upgrade.
		if (this.context.globalState.get<number>(SAMPLES_VERSION_KEY, 0) >= SAMPLES_VERSION) {
			return;
		}

		const dir = this.stylesUri;
		try {
			await vscode.workspace.fs.createDirectory(dir);
		} catch {
			// already exists (or unwritable) — proceed; writes below will surface real errors
		}

		const existing = await this.migrateSampleNames(dir);

		// Add any bundled sample that isn't present yet, reading its content from
		// the real .css file shipped under media/sample-styles/.
		for (const name of SAMPLE_FILE_NAMES) {
			if (existing.has(name)) continue;
			const bundled = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sample-styles', name);
			const content = await vscode.workspace.fs.readFile(bundled);
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), content);
		}

		// Delete samples we no longer ship.
		for (const removed of REMOVED_SAMPLE_NAMES) {
			if (existing.has(removed)) {
				try {
					await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, removed));
				} catch {
					// ignore — file may have vanished already
				}
			}
		}
		// If a removed theme was the active one — or nothing is active — fall back to
		// the default sample so the initial state always has a theme applied.
		const enabled = this.getEnabledIds();
		if (enabled.length === 0 || enabled.some((id) => REMOVED_SAMPLE_NAMES.includes(id))) {
			await this.setEnabledIds([DEFAULT_STYLE_NAME]);
		}

		await this.context.globalState.update(SAMPLES_VERSION_KEY, SAMPLES_VERSION);
	}

	/**
	 * Applies bundled-name migrations without overwriting a user's edited copy.
	 * When a target already exists, the old file is deliberately left untouched;
	 * this makes a collision recoverable and preserves the active old selection.
	 */
	private async migrateSampleNames(dir: vscode.Uri): Promise<Set<string>> {
		let existing = new Set((await this.listAllStyleFiles()).map((f) => f.name));
		const enabled = new Set(this.getEnabledIds());
		let enabledChanged = false;
		for (const { from, to } of SAMPLE_RENAMES) {
			if (!existing.has(from) || existing.has(to)) continue;
			try {
				await vscode.workspace.fs.rename(
					vscode.Uri.joinPath(dir, from),
					vscode.Uri.joinPath(dir, to),
					{ overwrite: false },
				);
				existing.delete(from);
				existing.add(to);
				if (enabled.delete(from)) {
					enabled.add(to);
					enabledChanged = true;
				}
			} catch {
				// Keep the old file when the filesystem cannot complete the rename.
			}
		}
		if (enabledChanged) await this.setEnabledIds([...enabled]);
		return existing;
	}

	private setupWatchers(): void {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.stylesUri, '*.css'));
		const onAny = () => void this.refresh();
		watcher.onDidChange(onAny);
		watcher.onDidCreate(onAny);
		watcher.onDidDelete(onAny);
		this.context.subscriptions.push(watcher);
	}

	private async listAllStyleFiles(): Promise<StyleFile[]> {
		try {
			const entries = await vscode.workspace.fs.readDirectory(this.stylesUri);
			return entries
				.filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.css'))
				.map(([name]) => ({ id: name, uri: vscode.Uri.joinPath(this.stylesUri, name), name }))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return [];
		}
	}

	private getEnabledIds(): string[] {
		return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string[]>(ENABLED_STYLES_KEY, []);
	}

	private async setEnabledIds(ids: string[]): Promise<void> {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update(ENABLED_STYLES_KEY, ids, vscode.ConfigurationTarget.Global);
	}

	async listEntries(): Promise<StyleEntry[]> {
		const files = await this.listAllStyleFiles();
		const enabled = new Set(this.getEnabledIds());
		const entries: StyleEntry[] = [];
		for (const f of files) {
			let css = '';
			try {
				css = Buffer.from(await vscode.workspace.fs.readFile(f.uri)).toString('utf8');
			} catch {
				// unreadable between listing and reading — show it without a preview
			}
			entries.push({ id: f.id, name: f.name, enabled: enabled.has(f.id), css });
		}
		return entries;
	}

	/** Selection is exclusive: enabling a style disables every other one. */
	async setEnabled(id: string, enabled: boolean): Promise<void> {
		await this.setEnabledIds(enabled ? [id] : []);
		await this.refresh();
	}

	async createNewStyle(): Promise<vscode.Uri> {
		const dir = this.stylesUri;
		try {
			await vscode.workspace.fs.stat(dir);
		} catch {
			await vscode.workspace.fs.createDirectory(dir);
		}
		const existingNames = new Set((await this.listAllStyleFiles()).map((f) => f.name));
	let name = '新建样式.css';
		let i = 1;
		while (existingNames.has(name)) {
			name = `新建样式 ${++i}.css`;
		}
		const uri = vscode.Uri.joinPath(dir, name);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(NEW_STYLE_TEMPLATE, 'utf8'));
		return uri;
	}

	/** 将样式复制为“<name> 的副本.css”（自动避免重名），副本不会自动启用。 */
	async duplicateStyle(id: string): Promise<vscode.Uri | undefined> {
		const files = await this.listAllStyleFiles();
		const file = files.find((f) => f.id === id);
		if (!file) return undefined;
		const base = file.name.replace(/\.css$/i, '');
		const existing = new Set(files.map((f) => f.name));
	let name = `${base} 的副本.css`;
		let i = 1;
		while (existing.has(name)) {
			name = `${base} 的副本 ${++i}.css`;
		}
		const target = vscode.Uri.joinPath(this.stylesUri, name);
		const bytes = await vscode.workspace.fs.readFile(file.uri);
		await vscode.workspace.fs.writeFile(target, bytes);
		await this.refresh();
		return target;
	}

	/**
	 * Rename a style file. `rawName` is sanitized (path separators stripped, `.css`
	 * ensured). Throws if the target already exists. If the renamed style was the
	 * enabled one, the selection is carried over to the new name.
	 */
	async renameStyle(id: string, rawName: string): Promise<void> {
		const files = await this.listAllStyleFiles();
		const file = files.find((f) => f.id === id);
		if (!file) return;
		let name = rawName.trim().replace(/[\\/:*?"<>|]/g, '').trim();
		if (!name) return;
		if (!/\.css$/i.test(name)) name += '.css';
		if (name === file.name) return;
		const target = vscode.Uri.joinPath(this.stylesUri, name);
		// overwrite:false makes fs.rename throw if the target exists, surfacing a
		// clear error to the caller rather than silently clobbering another style.
		await vscode.workspace.fs.rename(file.uri, target, { overwrite: false });
		if (this.getEnabledIds().includes(id)) {
			await this.setEnabledIds([name]);
		}
		await this.refresh();
	}

	async deleteStyle(id: string): Promise<void> {
		const files = await this.listAllStyleFiles();
		const file = files.find((f) => f.id === id);
		if (!file) return;
		await vscode.workspace.fs.delete(file.uri);
		if (this.getEnabledIds().includes(id)) {
			await this.setEnabled(id, false);
		}
	}

	async openStyleForEditing(id: string): Promise<void> {
		const uri = await this.resolveStyleUri(id);
		if (!uri) return;
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	/** Resolve a style id to its file URI, or undefined if it no longer exists. */
	async resolveStyleUri(id: string): Promise<vscode.Uri | undefined> {
		const files = await this.listAllStyleFiles();
		return files.find((f) => f.id === id)?.uri;
	}

	private async computeCombinedCss(): Promise<string> {
		const files = await this.listAllStyleFiles();
		const enabled = new Set(this.getEnabledIds());
		const parts: string[] = [];
		for (const file of files) {
			if (!enabled.has(file.id)) continue;
			try {
				const bytes = await vscode.workspace.fs.readFile(file.uri);
				parts.push(`/* ${file.name} */\n${Buffer.from(bytes).toString('utf8')}`);
			} catch {
				// file became unreadable between listing and reading; skip it
			}
		}
		return parts.join('\n\n');
	}

	private async refresh(): Promise<void> {
		this.cachedCss = await this.computeCombinedCss();
		this.onDidChangeEmitter.fire();
	}

	getCombinedCssSync(): string {
		return this.cachedCss;
	}
}
