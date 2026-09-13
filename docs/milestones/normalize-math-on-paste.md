# Milestone: Normalize Math on Paste

状态：进行中

## 来源与目标

- 来源：[GitHub Issue #53](https://github.com/uwougil/quarto-live-review-editor/issues/53)
- 目标：增加一个默认关闭的「Normalize math on paste」开关。启用后，所有粘贴都在同一次编辑事务内把 ChatGPT 常见的 LaTeX 分隔符 `\(...\)`、`\[...\]` 规范为 Markdown 的 `$...$`、`$$...$$`，同时不改写代码围栏、行内代码和既有 `$` 数学范围，也不改变公式内部原文。

## 实现映射

| 需求 | 实现 |
|---|---|
| 设置与侧栏开关 | `package.json` 的 `mdLivePreview.normalizeMathOnPaste`、`src/sidebar/StyleManagerViewProvider.ts`、`src/webview-sidebar/main.ts` |
| 初始状态与实时切换 | `src/shared/messages.ts`、`src/editor/documentSync.ts`、`src/editor/MarkdownLivePreviewProvider.ts`、`src/extension.ts`、`src/webview-editor/main.ts` |
| 分隔符改写与受保护范围 | `src/quarto/normalizeMathDelimiters.ts`，复用 `src/quarto/fence.ts` 与 `src/quarto/math.ts` 的掩码 |
| 单次编辑事务、跳过图片粘贴 | `src/webview-editor/mathPasteHandler.ts`、`src/webview-editor/main.ts` 的扩展顺序 |
| 单元回归 | `src/quarto/normalizeMathDelimiters.test.ts` |
| Chromium 回归 | `scripts/run-paste-normalization-browser-test.mjs`、`npm run test:browser:paste-math` |
| 产品与工程约束 | [`docs/PRD.md`](../PRD.md)（FR-12）、[`docs/EDD.md`](../EDD.md)（§3.3、§7） |

## 验收标准

- [x] `\( ... \)` 转换为 `$...$`，公式内部空格原样保留。
- [x] `\[ ... \]` 转换为独占行的 `$$ ... $$`，单行写法也得到同样的三行形式。
- [x] 多行 LaTeX 环境（如 `\begin{aligned}`）内部换行逐字保留。
- [x] `\(...\)` 内部存在异常换行时照常只替换分隔符。
- [x] 已有 `$...$` 与 `$$...$$` 完全不变。
- [x] fenced code block 内不转换；行内代码内不转换；光标位于文档已有围栏内粘贴时也不转换。
- [x] 仅在侧栏开关启用时生效，启用后所有粘贴都自动处理。
- [x] UI 全程静默，不产生 toast 或其他反馈。
- [x] 一次粘贴只产生一条宿主编辑，一次 Undo 撤销整次 paste + normalization。
- [x] 开启后未命中的粘贴仍走 CodeMirror 内置粘贴行为。

## 验证记录

本地全部通过：

```powershell
npm run typecheck
npm test                             # 40 files, 475 passed | 2 skipped
npm run compile
npm run test:browser:paste-math      # 新增回归
npm run test:browser
npm run test:browser:geometry
npm run test:browser:inline
npm run test:browser:inline-interaction
npm run test:browser:typewriter
npm run test:browser:arrow-scroll
npm run test:browser:zoom
npm run test:browser:math
```

`npm run test:browser:paste-math` 在真实 Chromium 中派发真实 `paste` 事件并断言：开启后行内得到 `Pasted $E = mc^2$ here` 且只产生**一条** `edit`；块公式得到 `$$\nE = mc^2\n$$`；开关关闭时插入文本仍是 `\(E = mc^2\)`；光标位于文档已有围栏内时插入 `\(x\)` 原样保留；不含 LaTeX 分隔符的粘贴仍走内置路径。

已知限制：编辑器未启用 `EditorState.allowMultipleSelections`，CodeMirror 会把多选区折叠为单光标，因此本次未覆盖多光标粘贴；改写使用 `state.changeByRange`，启用多选区后该路径无需修改。

