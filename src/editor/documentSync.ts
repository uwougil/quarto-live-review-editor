import * as vscode from 'vscode';
import type { EditorToHostMessage, HostToEditorMessage, TextChange } from '../shared/messages';
import { pickCodeTheme, tokenizeDocument } from './shikiHost';
import { allocateImageTimestamp, extensionForMimeType, generateImageFileName } from '../shared/imageAssets';
import { resolveLinkTarget } from '../shared/linkTarget';
import { isPathInside } from '../shared/pathContainment';
import { documentDialectForPath } from '../quarto/dialect';
import { findMarkdownAnchorLine } from '../shared/headings';
import { TokenizationGate } from './tokenizationGuard';
import { DocumentSyncCoordinator, type DocumentSyncPeer } from './documentSyncCoordinator';
import {
	DOCUMENT_ZOOM_DEFAULT,
	normalizeDocumentZoom,
	READING_WIDTH_DEFAULT,
	normalizeReadingWidth,
} from '../shared/documentZoom';

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
export class DocumentSyncSession implements DocumentSyncPeer {
	private disposables: vscode.Disposable[] = [];
	private rehighlightTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly tokenizationGate = new TokenizationGate();
	private readonly ownsCoordinator: boolean;
	private readonly coordinator: DocumentSyncCoordinator;

	constructor(
		private readonly document: vscode.TextDocument,
		private readonly webviewPanel: vscode.WebviewPanel,
		private readonly getCss: () => string,
		private readonly openDocumentAtLine?: (uri: vscode.Uri, line?: number) => Promise<void>,
		private readonly getDocumentZoom: () => number = () => DOCUMENT_ZOOM_DEFAULT,
		private readonly onDocumentZoomChange: (percent: number) => void = () => undefined,
		coordinator?: DocumentSyncCoordinator,
		private readonly getTypewriterMode: () => boolean = () => false,
		private readonly getReadingWidth: () => number = () => READING_WIDTH_DEFAULT,
		private readonly onReadingWidthChange: (percent: number) => void = () => undefined,
	) {
		this.ownsCoordinator = !coordinator;
		this.coordinator = coordinator ?? new DocumentSyncCoordinator(document);
		this.coordinator.addPeer(this);

		this.disposables.push(
			webviewPanel.webview.onDidReceiveMessage((message: EditorToHostMessage) => this.handleMessage(message)),
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
				void this.coordinator.enqueueEdit(this, message.changes, message.baseVersion, message.editId);
				break;
			case 'requestResync':
				this.sendResync();
				break;
			case 'undo':
				// The shared coordinator queues this behind edits from every panel so
				// undo cannot act on an older document state. The session callback also
				// restores and verifies this panel before invoking the global command.
				void this.coordinator.enqueueCommand(this, 'undo');
				break;
			case 'redo':
				void this.coordinator.enqueueCommand(this, 'redo');
				break;
			case 'openLink':
				void this.openLink(message.href);
				break;
			case 'pasteImage':
				void this.coordinator.enqueueHostMutation(() => this.handlePasteImage(message));
				break;
			case 'readDrawioFile':
				void this.handleReadDrawioFile(message.requestId, message.src);
				break;
			case 'setZoom':
				this.onDocumentZoomChange(normalizeDocumentZoom(message.percent));
				break;
			case 'setReadingWidth':
				this.onReadingWidthChange(normalizeReadingWidth(message.percent));
				break;
		}
	}

	/**
	 * Runs a native history command against the session that originated it.
	 *
	 * `undo` and `redo` are global, focus-based VS Code commands. The message
	 * itself belongs to this session, but the queued callback may run after the
	 * user has activated another editor. Reveal this panel first, then verify
	 * that both the panel and its document are still active before invoking the
	 * command. If VS Code cannot restore that context (for example, the panel
	 * was disposed while the edit queue was draining), refuse the operation so
	 * another document is never modified by accident.
	 */
	async runHistoryCommand(command: 'undo' | 'redo'): Promise<void> {
		if (!this.webviewPanel.active) {
			try {
				this.webviewPanel.reveal(undefined, false);
			} catch {
				return;
			}
		}

		if (!this.webviewPanel.active) return;
		const activeTabGroup = vscode.window.tabGroups?.activeTabGroup;
		if (activeTabGroup) {
			const input = activeTabGroup.activeTab?.input;
			if (!(input instanceof vscode.TabInputCustom) || input.uri.toString() !== this.document.uri.toString()) {
				return;
			}
		}

		await vscode.commands.executeCommand(command);
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
		if (target.kind === 'fragment') {
			this.jumpToFragment(target.fragment);
			return;
		}
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
		let targetLine: number | undefined;
		if (target.fragment) {
			try {
				const targetDocument = await vscode.workspace.openTextDocument(uri);
				targetLine = findMarkdownAnchorLine(targetDocument.getText(), target.fragment);
				if (targetLine === undefined) void vscode.window.showWarningMessage(`找不到链接锚点：#${target.fragment}`);
			} catch {
				void vscode.window.showWarningMessage(`无法读取链接目标：${target.path}`);
			}
		}
		try {
			if (this.openDocumentAtLine) await this.openDocumentAtLine(uri, targetLine);
			else await vscode.commands.executeCommand('vscode.open', uri);
		} catch {
			// Not something the editor can display (a PDF, an archive, an
			// executable): let the OS decide what to do with it.
			await vscode.env.openExternal(uri);
		}
	}

	private jumpToFragment(fragment: string): void {
		const line = findMarkdownAnchorLine(this.document.getText(), fragment);
		if (line === undefined) {
			void vscode.window.showWarningMessage(`找不到链接锚点：#${fragment}`);
			return;
		}
		this.jumpToLine(line);
	}

	/**
	 * Saves a pasted/dropped image under an `assets/` folder beside the
	 * document and inserts a Markdown image link at `atPos`. This edit
	 * originates on the host (the final relative path is only known after
	 * writing the file). It is serialized behind text edits by the shared
	 * coordinator, and its resulting document change is broadcast to every panel.
	 */
	private async handlePasteImage(message: Extract<EditorToHostMessage, { type: 'pasteImage' }>): Promise<void> {
		const fail = (error: string) => {
			this.post({ type: 'imageResult', requestId: message.requestId, ok: false, error });
		};
		if (message.baseVersion !== this.document.version || message.atPos < 0 || message.atPos > this.document.getText().length) {
			this.sendResync();
			fail('文档已变化，请重试图片插入。');
			return;
		}
		const ext = extensionForMimeType(message.mimeType);
		if (!ext) {
			fail('不支持的图片格式。');
			return;
		}

		const docDir = vscode.Uri.joinPath(this.document.uri, '..');
		const assetsDir = vscode.Uri.joinPath(docDir, 'assets');
		try {
			await vscode.workspace.fs.createDirectory(assetsDir);
		} catch {
			fail('无法创建图片资源目录。');
			return;
		}

		let existingNames: string[];
		try {
			existingNames = (await vscode.workspace.fs.readDirectory(assetsDir)).map(([name]) => name);
		} catch {
			existingNames = [];
		}
		const fileName = generateImageFileName(new Set(existingNames), allocateImageTimestamp(), ext);
		const fileUri = vscode.Uri.joinPath(assetsDir, fileName);
		try {
			await vscode.workspace.fs.writeFile(fileUri, Buffer.from(message.dataBase64, 'base64'));
		} catch {
			fail('无法保存图片资源。');
			return;
		}
		const cleanup = async () => {
			try {
				await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: false });
			} catch {
				// Best effort: only the exact file created by this request is targeted.
			}
		};
		if (message.baseVersion !== this.document.version) {
			await cleanup();
			this.sendResync();
			fail('文档在图片保存期间发生变化，请重试。');
			return;
		}

		// `atPos` was relocated to just after a table (see `escapeTable` in
		// imagePasteHandler.ts) when the cursor was inside one — a leading
		// blank line separates the image into its own paragraph instead of
		// running it straight onto the table's last line.
		const insertText = message.needsOwnParagraph ? `\n\n![](assets/${fileName})` : `![](assets/${fileName})`;
		const position = this.document.positionAt(message.atPos);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(this.document.uri, position, insertText);
		let applied = false;
		try {
			applied = await vscode.workspace.applyEdit(edit);
		} catch {
			applied = false;
		}
		if (!applied) {
			await cleanup();
			this.sendResync();
			fail('无法把图片引用写入文档。');
			return;
		}

		this.post({ type: 'imageResult', requestId: message.requestId, ok: true });
		this.post({ type: 'setCursor', pos: message.atPos + insertText.length });
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
			typewriterMode: this.getTypewriterMode(),
			zoomPercent: normalizeDocumentZoom(this.getDocumentZoom()),
			readingWidthPercent: normalizeReadingWidth(this.getReadingWidth()),
		});
	}

	private sendResync(rejectedEditId?: number): void {
		this.post({ type: 'resync', text: this.document.getText(), version: this.document.version, rejectedEditId });
	}

	receiveDocumentChanges(changes: TextChange[], baseVersion: number, version: number): void {
		this.post({ type: 'externalUpdate', changes, baseVersion, version });
		this.scheduleRehighlight();
	}

	acknowledgeEdit(editId: number, version: number): void {
		this.post({ type: 'ackEdit', editId, version });
		this.scheduleRehighlight();
	}

	resync(rejectedEditId?: number): void { this.sendResync(rejectedEditId); }

	private scheduleRehighlight(immediate = false) {
		if (this.rehighlightTimer) {
			clearTimeout(this.rehighlightTimer);
			this.rehighlightTimer = undefined;
		}
		const ticket = this.tokenizationGate.begin(this.document.version);
		const run = () => {
			this.rehighlightTimer = undefined;
			void tokenizeDocument(this.document).then((result) => {
				if (!this.tokenizationGate.canPublish(ticket, this.document.version) || result.version !== ticket.version) return;
				this.post({ type: 'codeTokens', version: result.version, generation: ticket.generation, blocks: result.blocks });
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

	notifyTypewriterModeChanged() {
		this.post({ type: 'typewriterModeChanged', enabled: this.getTypewriterMode() });
	}

	notifyDocumentZoomChanged(percent: number): void {
		this.post({ type: 'setZoom', percent: normalizeDocumentZoom(percent) });
	}

	notifyReadingWidthChanged(percent: number): void {
		this.post({ type: 'setReadingWidth', percent: normalizeReadingWidth(percent) });
	}

	getDocument(): vscode.TextDocument {
		return this.document;
	}

	get uriKey(): string {
		return this.document.uri.toString();
	}

	get active(): boolean {
		return this.webviewPanel.active;
	}

	jumpToLine(line: number): void {
		this.post({ type: 'jumpToLine', line });
	}

	dispose() {
		this.coordinator.removePeer(this);
		if (this.ownsCoordinator) this.coordinator.dispose();
		if (this.rehighlightTimer) {
			clearTimeout(this.rehighlightTimer);
		}
		this.tokenizationGate.invalidate();
		this.disposables.forEach((d) => d.dispose());
	}
}
