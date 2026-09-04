import * as vscode from 'vscode';
import type { EditorToHostMessage, HostToEditorMessage, TextChange } from '../shared/messages';
import { pickCodeTheme, tokenizeDocument } from './shikiHost';
import { extensionForMimeType, generateImageFileName } from '../shared/imageAssets';
import { resolveLinkTarget } from '../shared/linkTarget';
import { isPathInside } from '../shared/pathContainment';
import { documentDialectForPath } from '../quarto/dialect';

/**
 * Largest `.drawio` file that will be read and parsed.
 *
 * A hand-drawn diagram is a few hundred kilobytes at most; well past that the
 * file is either machine-generated or not a diagram, and parsing it would lock
 * up the webview's single thread with nothing useful to show at the end.
 */
const MAX_DRAWIO_BYTES = 5 * 1024 * 1024;

/**
 * Whether `target` sits inside the `dir` tree.
 *
 * Compared over `fsPath` rather than the URI string so that percent-encoding
 * differences (a space as `%20` on one side and a literal space on the other)
 * cannot make an inside path look outside. Case-insensitivity follows the
 * platform: only Windows treats `C:\Notes` and `c:\notes` as one folder.
 */
function isInside(dir: vscode.Uri, target: vscode.Uri): boolean {
	if (dir.scheme !== target.scheme || dir.authority !== target.authority) return false;
	return isPathInside(dir.fsPath, target.fsPath, process.platform === 'win32');
}

const REHIGHLIGHT_DEBOUNCE_MS = 150;

/**
 * Owns the sync relationship between one vscode.TextDocument and one webview panel
 * showing it. All edits from the webview are applied via WorkspaceEdit so that
 * VS Code's native undo/redo stack stays the single source of truth (CM6's own
 * history extension is intentionally not used in the webview).
 */
export class DocumentSyncSession {
	private disposables: vscode.Disposable[] = [];
	private lastAppliedVersion: number;
	// True for the entire span of an applyEdit() call, including the synchronous
	// onDidChangeTextDocument dispatch that happens *inside* workspace.applyEdit()
	// before its promise resolves. Without this, handleDocumentChanged sees that
	// echo before lastAppliedVersion has been bumped and mistakes our own edit for
	// an external one, re-sending it to the webview on top of text that already
	// has it — corrupting later offset math and losing/duplicating characters.
	private applyingLocalEdit = false;
	private rehighlightTimer: ReturnType<typeof setTimeout> | undefined;
	// Serializes 'edit' messages so a fast second edit can't race the first one's
	// applyEdit(): without this, its baseVersion check could run before the prior
	// edit has actually bumped document.version, defeating the staleness guard.
	private editQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly document: vscode.TextDocument,
		private readonly webviewPanel: vscode.WebviewPanel,
		private readonly getCss: () => string,
	) {
		this.lastAppliedVersion = document.version;

		this.disposables.push(
			webviewPanel.webview.onDidReceiveMessage((message: EditorToHostMessage) => this.handleMessage(message)),
		);

		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (event.document.uri.toString() === document.uri.toString()) {
					this.handleDocumentChanged(event);
				}
			}),
		);

		this.disposables.push(
			vscode.window.onDidChangeActiveColorTheme(() => this.scheduleRehighlight(true)),
		);
	}

	private post(message: HostToEditorMessage) {
		this.webviewPanel.webview.postMessage(message);
	}

	private handleMessage(message: EditorToHostMessage) {
		switch (message.type) {
			case 'ready':
				this.sendInit();
				this.scheduleRehighlight(true);
				break;
			case 'edit':
				this.editQueue = this.editQueue.catch(() => undefined).then(() => this.applyEdit(message.changes, message.baseVersion));
				break;
			case 'undo':
				// Chained onto editQueue (not fired immediately) so it can't run ahead
				// of an 'edit' message still being applied — otherwise it would undo
				// the wrong (older) change and desync from the webview's local state.
				this.editQueue = this.editQueue.catch(() => undefined).then(() => vscode.commands.executeCommand('undo'));
				break;
			case 'redo':
				this.editQueue = this.editQueue.catch(() => undefined).then(() => vscode.commands.executeCommand('redo'));
				break;
			case 'openLink':
				void this.openLink(message.href);
				break;
			case 'pasteImage':
				void this.handlePasteImage(message.atPos, message.mimeType, message.dataBase64, message.needsOwnParagraph);
				break;
			case 'readDrawioFile':
				void this.handleReadDrawioFile(message.requestId, message.src);
				break;
		}
	}

	/**
	 * Reads a `.drawio` file referenced from the document and sends its text back.
	 *
	 * The webview cannot touch the filesystem, and an `<img>` cannot render
	 * mxGraph XML, so a `![](diagram.drawio)` reference has to come through here.
	 *
	 * The path is confined to the document's own folder tree. `src` comes
	 * straight out of the Markdown, so it can say `../../../../etc/passwd`, and
	 * this handler would otherwise happily read it and hand the contents to the
	 * webview — turning "open a Markdown file someone sent you" into an arbitrary
	 * file read. Resolving first and then checking that the result is still under
	 * the document's directory is what closes that, and it is done on the
	 * resolved path because `..` segments only cancel out after resolution.
	 */
	private async handleReadDrawioFile(requestId: number, src: string): Promise<void> {
		const reply = (payload: { text?: string; error?: string }) => {
			void this.webviewPanel.webview.postMessage({ type: 'drawioFile', requestId, ...payload });
		};

		const target = resolveLinkTarget(src);
		if (target.kind !== 'relative') {
			// A remote diagram would mean the webview fetching over the network on
			// behalf of a file the user merely opened; only local files are read.
			reply({ error: '只能显示本地 .drawio 文件。' });
			return;
		}

		const docDir = vscode.Uri.joinPath(this.document.uri, '..');
		const uri = vscode.Uri.joinPath(docDir, target.path);
		if (!isInside(docDir, uri)) {
			reply({ error: '不能读取文档文件夹之外的文件。' });
			return;
		}

		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			// Guard against a file large enough to lock up the webview's parser. A
			// hand-drawn diagram is a few hundred kilobytes at most; well past that
			// is either machine-generated or not a diagram at all.
			if (bytes.byteLength > MAX_DRAWIO_BYTES) {
			reply({ error: '文件过大（超过 5MB）。' });
				return;
			}
			reply({ text: new TextDecoder('utf-8').decode(bytes) });
		} catch {
			reply({ error: `无法读取文件：${target.path}` });
		}
	}

	/**
	 * Follows a link from the preview.
	 *
	 * `openExternal(Uri.parse(href))` was used for every link, which is right
	 * only for one that already carries a scheme. A relative link — `./notes.md`,
	 * `../img/a.png`, or a bare `notes.md`, the common case in a Markdown file —
	 * parses into a scheme-less URI that resolves against nothing, and the shell
	 * was handed a path it could not find ("0x2"). Those are resolved against the
	 * document's own folder instead, and opened in the editor rather than the
	 * shell, which is what following a link between notes should do.
	 */
	private async openLink(href: string): Promise<void> {
		const target = resolveLinkTarget(href);
		if (target.kind === 'ignore') return;
		if (target.kind === 'external') {
			await vscode.env.openExternal(vscode.Uri.parse(target.href));
			return;
		}

		const docDir = vscode.Uri.joinPath(this.document.uri, '..');
		const uri = vscode.Uri.joinPath(docDir, target.path);
		try {
			// Confirm it exists before opening. `vscode.open` on a missing file
			// raises its own OS-level error dialog, which is the very thing being
			// fixed here; a message naming the path is more use than "0x2".
			await vscode.workspace.fs.stat(uri);
		} catch {
			void vscode.window.showWarningMessage(`找不到链接目标：${target.path}`);
			return;
		}
		try {
			await vscode.commands.executeCommand('vscode.open', uri);
		} catch {
			// Not something the editor can display (a PDF, an archive, an
			// executable): let the OS decide what to do with it.
			await vscode.env.openExternal(uri);
		}
	}

	/**
	 * Saves a pasted/dropped image under an `assets/` folder beside the
	 * document and inserts a Markdown image link at `atPos`. This edit
	 * originates on the host (the final relative path is only known after
	 * writing the file), unlike every other edit in this class — so it is
	 * applied as a plain `vscode.WorkspaceEdit` (not via `applyEdit()`) and
	 * deliberately does *not* set `applyingLocalEdit`, letting the existing
	 * `handleDocumentChanged` → `externalUpdate` path deliver it to the
	 * webview exactly as if it were an edit from another tab.
	 */
	private async handlePasteImage(
		atPos: number,
		mimeType: string,
		dataBase64: string,
		needsOwnParagraph: boolean,
	): Promise<void> {
		const ext = extensionForMimeType(mimeType);
		if (!ext) return; // unrecognized type — ignore rather than save a file with an unknown format

		const docDir = vscode.Uri.joinPath(this.document.uri, '..');
		const assetsDir = vscode.Uri.joinPath(docDir, 'assets');
		await vscode.workspace.fs.createDirectory(assetsDir);

		let existingNames: string[];
		try {
			existingNames = (await vscode.workspace.fs.readDirectory(assetsDir)).map(([name]) => name);
		} catch {
			existingNames = [];
		}
		const fileName = generateImageFileName(new Set(existingNames), Date.now(), ext);
		const fileUri = vscode.Uri.joinPath(assetsDir, fileName);
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(dataBase64, 'base64'));

		// `atPos` was relocated to just after a table (see `escapeTable` in
		// imagePasteHandler.ts) when the cursor was inside one — a leading
		// blank line separates the image into its own paragraph instead of
		// running it straight onto the table's last line.
		const insertText = needsOwnParagraph ? `\n\n![](assets/${fileName})` : `![](assets/${fileName})`;
		const position = this.document.positionAt(atPos);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(this.document.uri, position, insertText);
		await vscode.workspace.applyEdit(edit);

		this.post({ type: 'setCursor', pos: atPos + insertText.length });
	}

	private sendInit() {
		const docDir = vscode.Uri.joinPath(this.document.uri, '..');
		this.post({
			type: 'init',
			text: this.document.getText(),
			version: this.document.version,
			css: this.getCss(),
			codeTheme: pickCodeTheme(),
			dialect: documentDialectForPath(this.document.uri.path),
			baseUri: `${this.webviewPanel.webview.asWebviewUri(docDir).toString()}/`,
		});
		this.lastAppliedVersion = this.document.version;
	}

	private async applyEdit(changes: TextChange[], baseVersion: number) {
		if (baseVersion !== this.document.version) {
			// Webview's batch was computed against a document snapshot that has since
			// moved on (e.g. an external edit landed concurrently). Rather than risk
			// corrupting the file with stale offsets, discard the batch and force a
			// full resync; the user may lose only the last, still-unacknowledged burst
			// of local keystrokes in this rare race.
			this.sendInit();
			return;
		}
		if (changes.length === 0) {
			return;
		}

		const edit = new vscode.WorkspaceEdit();
		for (const change of changes) {
			edit.replace(
				this.document.uri,
				new vscode.Range(this.document.positionAt(change.from), this.document.positionAt(change.to)),
				change.insert,
			);
		}

		this.applyingLocalEdit = true;
		try {
			await vscode.workspace.applyEdit(edit);
		} finally {
			this.applyingLocalEdit = false;
		}
		this.lastAppliedVersion = this.document.version;
		this.post({ type: 'ackEdit', version: this.document.version });
		this.scheduleRehighlight();
	}

	private handleDocumentChanged(event: vscode.TextDocumentChangeEvent) {
		if (this.applyingLocalEdit) {
			// Echo of the edit applyEdit() is in the middle of making; the webview
			// already reflects it locally, so there is nothing to forward. Still
			// track the version so a later genuine external edit compares correctly.
			this.lastAppliedVersion = event.document.version;
			return;
		}
		if (event.document.version <= this.lastAppliedVersion) {
			// This change is the echo of an edit we just applied ourselves; the
			// webview already reflects it locally, so there is nothing to forward.
			return;
		}
		this.lastAppliedVersion = event.document.version;
		if (event.contentChanges.length === 0) {
			return;
		}

		const changes: TextChange[] = event.contentChanges.map((c) => ({
			from: c.rangeOffset,
			to: c.rangeOffset + c.rangeLength,
			insert: c.text,
		}));
		this.post({ type: 'externalUpdate', changes, version: event.document.version });
		this.scheduleRehighlight();
	}

	private scheduleRehighlight(immediate = false) {
		if (this.rehighlightTimer) {
			clearTimeout(this.rehighlightTimer);
			this.rehighlightTimer = undefined;
		}
		const run = () => {
			this.rehighlightTimer = undefined;
			void tokenizeDocument(this.document).then((blocks) => {
				this.post({ type: 'codeTokens', blocks });
			});
		};
		if (immediate) {
			run();
		} else {
			this.rehighlightTimer = setTimeout(run, REHIGHLIGHT_DEBOUNCE_MS);
		}
	}

	notifyCssChanged() {
		this.post({ type: 'applyCss', css: this.getCss() });
	}

	getDocument(): vscode.TextDocument {
		return this.document;
	}

	jumpToLine(line: number): void {
		this.post({ type: 'jumpToLine', line });
	}

	dispose() {
		if (this.rehighlightTimer) {
			clearTimeout(this.rehighlightTimer);
		}
		this.disposables.forEach((d) => d.dispose());
	}
}
