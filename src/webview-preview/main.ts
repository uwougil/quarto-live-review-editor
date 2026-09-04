import type { HostToPreviewMessage, PreviewToHostMessage } from '../shared/messages';

interface VsCodeApi {
	postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const api = acquireVsCodeApi();

function post(message: PreviewToHostMessage): void {
	api.postMessage(message);
}

// A representative Markdown document (as real HTML) covering the elements a theme
// styles, so the author sees the full effect of their CSS as they type. Theme CSS
// is authored for VS Code's Markdown preview, i.e. against real <body>/<h1>/… —
// so it applies here directly, no adaptation needed.
const SAMPLE_HTML = `
<h1>标题 1 (Heading 1)</h1>
<p>这是正文段落，包含<strong>粗体</strong>、<em>斜体</em>、<del>删除线</del>、
<code>inline code</code> 和 <a href="#">链接</a>。</p>

<h2>标题 2 (Heading 2)</h2>
<p>另一个段落。可以用来检查中文和 English 混排时的行距与字距。</p>

<blockquote>
	<p>引用块示例，用于查看引用来源或备注时的显示效果。</p>
</blockquote>

<h3>标题 3 (Heading 3)</h3>
<ul>
	<li>无序列表项 1</li>
	<li>无序列表项 2
		<ul><li>嵌套列表项</li></ul>
	</li>
</ul>
<ol>
	<li>有序列表项 1</li>
	<li>有序列表项 2</li>
</ol>

<ul class="contains-task-list">
	<li><input type="checkbox" checked disabled> 已完成任务</li>
	<li><input type="checkbox" disabled> 未完成任务</li>
</ul>

<h3>表格 (Table)</h3>
<table>
	<thead><tr><th>列 A</th><th>列 B</th><th>列 C</th></tr></thead>
	<tbody>
		<tr><td>1</td><td>甲乙丙丁戊</td><td>x</td></tr>
		<tr><td>2</td><td>己庚辛壬癸</td><td>y</td></tr>
	</tbody>
</table>

<h3>代码块 (Code block)</h3>
<pre><code>function greet(name) {
  // 注释
  return \`Hello, \${name}!\`;
}
</code></pre>

<hr />
<p>分隔线下方的段落。</p>
`;

const themeStyle = document.getElementById('mlp-theme-style') as HTMLStyleElement;
const content = document.getElementById('mlp-preview-content')!;
content.innerHTML = SAMPLE_HTML;

const HL_CLASS = 'mlp-hl';
const THEME_KINDS = ['vscode-light', 'vscode-dark', 'vscode-high-contrast'];

function setThemeKind(kind: string): void {
	// Swap only the theme-kind class so a highlight on <body> (from a `body` rule)
	// isn't wiped when the CSS is re-pushed.
	document.body.classList.remove(...THEME_KINDS);
	document.body.classList.add(kind);
}

function clearHighlight(): void {
	document.querySelectorAll('.' + HL_CLASS).forEach((el) => el.classList.remove(HL_CLASS));
}

function tryQuery(selector: string): Element[] {
	try {
		// Query the whole document so `body`, `body.vscode-dark h1`, etc. resolve
		// against the real <body> (which carries the theme-kind class).
		return Array.from(document.querySelectorAll(selector));
	} catch {
		return []; // invalid/unsupported selector
	}
}

function applyHighlight(selector: string | null): void {
	clearHighlight();
	if (!selector) return;
	const sel = selector.trim();
	if (!sel || sel.startsWith('@')) return; // at-rule prelude — nothing to point at

	let els = tryQuery(sel);
	if (els.length === 0) {
		// The rule may be gated on the *other* theme mode (e.g. `body.vscode-dark h1`
		// while the preview is light). Retry with the `body.vscode-*` gate removed so
		// the author still sees which element the rule targets.
		const stripped = sel
			.split(',')
			.map((s) => s.replace(/\bbody(?:\.[-\w]+)*\s*/g, '').trim())
			.filter(Boolean)
			.join(', ');
		els = stripped ? tryQuery(stripped) : [document.body];
	}
	els.forEach((el) => el.classList.add(HL_CLASS));
}

window.addEventListener('message', (event: MessageEvent<HostToPreviewMessage>) => {
	const message = event.data;
	if (message.type === 'update') {
		themeStyle.textContent = message.css;
		// The theme's `body.vscode-dark` / `.vscode-light` gates key off this class.
		setThemeKind(message.themeKind);
	} else if (message.type === 'highlight') {
		applyHighlight(message.selector);
	}
});

post({ type: 'ready' });
