# Milestone: Normalize Math on Paste

状态：已完成

## 来源与目标

- 来源：[GitHub Issue #53](https://github.com/uwougil/quarto-live-review-editor/issues/53)
- 目标：增加一个默认关闭的「Normalize math on paste」开关。启用后，所有粘贴都在同一次编辑事务内把 ChatGPT 常见的 LaTeX 分隔符 `\(...\)`、`\[...\]` 规范为 Markdown 的 `$...$`、`$$...$$`，同时不改写代码围栏、行内代码、既有 `$` 数学范围或受保护的目标，也不改变公式内部原文。

## 实现映射

| 需求 | 实现 |
|---|---|
| 设置与侧栏开关 | `package.json` 的 `mdLivePreview.normalizeMathOnPaste`、`src/sidebar/StyleManagerViewProvider.ts`、`src/webview-sidebar/main.ts` |
| 初始状态与实时切换 | `src/shared/messages.ts`、`src/editor/documentSync.ts`、`src/editor/MarkdownLivePreviewProvider.ts`、`src/extension.ts`、`src/webview-editor/main.ts` |
| 分隔符改写与受保护范围 | `src/quarto/normalizeMathDelimiters.ts`，复用 `src/quarto/fence.ts` 与 `src/quarto/math.ts` 的掩码，并检查目标文档的 front matter、围栏、行内代码和既有数学范围 |
| 目标行上下文与显示数学边界 | `src/webview-editor/mathPasteHandler.ts`，按整个替换选区回退不安全粘贴，并按目标文档的 LF/CRLF 只补必要换行 |
| 单次编辑事务、跳过图片粘贴 | `src/webview-editor/mathPasteHandler.ts`、`src/webview-editor/main.ts` 的扩展顺序 |
| 单元回归 | `src/quarto/normalizeMathDelimiters.test.ts`、`src/webview-editor/mathPasteHandler.test.ts` |
| Chromium 回归 | `scripts/run-paste-normalization-browser-test.mjs`、`npm run test:browser:paste-math` |
| 产品与工程约束 | [`docs/PRD.md`](../PRD.md)（FR-13）、[`docs/EDD.md`](../EDD.md)（§3.3、§7） |

## 验收标准

- [x] `\( ... \)` 转换为 `$...$`，公式内部空格原样保留。
- [x] `\[ ... \]` 转换为独占行的 `$$ ... $$`，单行写法也得到同样的三行形式。
- [x] 多行 LaTeX 环境（如 `\begin{aligned}`）内部换行逐字保留。
- [x] `\(...\)` 内部存在异常换行时照常只替换分隔符。
- [x] 已有 `$...$` 与 `$$...$$` 完全不变。
- [x] fenced code block 内不转换；行内代码、既有 inline/display math、front matter 内的目标和光标位于文档已有围栏内粘贴时也不转换。
- [x] 替换选区只要与受保护范围相交就整次回退；未来多选区中存在不安全目标时不部分规范化。
- [x] 显示数学粘贴到行中间时，两个 `$$` 分隔符各自独占一行；行首、行尾、空行和相邻换行不产生多余空行，并遵循目标文档的 CRLF/LF。
- [x] 仅在侧栏开关启用时生效，启用后所有粘贴都自动处理。
- [x] UI 全程静默，不产生 toast 或其他反馈。
- [x] 一次粘贴只产生一条宿主 `edit`，且规范化属于同一编辑事务；Live Preview 全链路 Ctrl+Z 仍由 Issue #34 负责，本里程碑不宣称已端到端验证。
- [x] 开启后未命中的粘贴仍走 CodeMirror 内置粘贴行为。

## 验证记录

本地验证全部通过（恢复后的 `main` 内容等同事故前 `7f6b5d9`；实现分支从恢复提交 `74b84d7` 建立）：

```powershell
npm run typecheck                    # 通过
npm test                             # 44 files, 524 passed
npm run compile                      # esbuild + tsc 通过
npm run test:integration             # 通过
npm run test:browser:paste-math      # 本次新增回归，{"ok":true}
npm run test:browser
npm run test:browser:geometry
npm run test:browser:inline
npm run test:browser:inline-interaction
npm run test:browser:typewriter
npm run test:browser:arrow-scroll
npm run test:browser:zoom
npm run test:browser:math
npm run test:browser:footnote-caret
```

`npm run test:browser:paste-math` 在真实 Chromium 中派发真实 `paste` 事件并断言：开启/关闭模式、围栏/行内代码/已有 inline-display math 目标、行中/行首/行尾/空行显示数学、替换选区、普通内置粘贴、单条 `edit` 和 `pageerror`。显示数学目标上下文会得到真正独占行的 `$$`，且不添加多余空行。

已知限制：编辑器未启用 `EditorState.allowMultipleSelections`，CodeMirror 会把多选区折叠为单光标，因此本次未覆盖真实多光标 DOM 粘贴；保护逻辑已定义为任一不安全目标使整次粘贴回退。Issue #34 仍拥有 Live Preview Undo/Redo 的端到端问题，本次只验证单条 host `edit`/单次编辑事务，不宣称 Ctrl+Z 全链路通过。

