# Milestone: 独立的 Live Preview 字号与正文阅读区宽度

状态：已完成

## 来源与目标

- 来源：[GitHub Issue #28](https://github.com/uwougil/quarto-live-review-editor/issues/28)
- 目标：将 Live Preview 的 typography zoom 与正文 reading-column width 拆成独立的状态、快捷键、CSS 职责和全局持久化值。

## 实现映射

| 需求 | 实现 |
|---|---|
| 独立值域、10% 步进与 180% 后的 Full 状态 | `src/shared/documentZoom.ts` |
| 单一快捷键事件 owner 与 Ctrl/Mod 平台规则 | `src/webview-editor/documentZoom.ts` |
| 根节点 CSS 状态、Full 响应式布局与 CodeMirror measure | `src/webview-editor/main.ts`、`media/webview-editor-theme.css` |
| 主题 finite reading-column 宽度安全适配 | `src/shared/cssAdapter.ts` |
| 两个 globalState 值与跨 panel 广播 | `src/editor/MarkdownLivePreviewProvider.ts`、`src/editor/documentSync.ts`、`src/shared/messages.ts` |
| Unit 与 host-sync 回归 | `src/shared/documentZoom.test.ts`、`src/shared/cssAdapter.test.ts`、`src/editor/documentSync.test.ts` |
| Chromium 回归 | `scripts/run-document-zoom-browser-test.mjs`、`npm run test:browser:zoom` |

## 验收标准

- [x] `Ctrl/Mod`+滚轮只改变 typography zoom（70%–200%）。
- [x] `Ctrl/Mod +`/`-` 只改变 reading width（60%–180%）；180% 后增加进入 Full，减少从 Full 回到 180%。
- [x] `Ctrl/Mod + 0` 与 `Ctrl/Mod + Shift + 0` 分别只重置对应值。
- [x] 两个值独立持久化、跨 panel 同步、reopen 后恢复，且不修改源文本或 VS Code/browser zoom。
- [x] finite `px`/`rem` reading-column baseline 可安全缩放；百分比、`none`、viewport 单位、`min()`/`clamp()`、混合/custom selector 保持合法原值。
- [x] CodeMirror wrapping、caret/selection/hit testing 与 `transform: scale` 非使用由真实 Chromium 回归保护。
- [x] Full 下 typography、resize、reopen、多个面板消息和代表性内置主题由单元/真实 Chromium 回归覆盖。

## 验证记录

- `npm test`：39 个测试文件、473 个测试通过。
- `npm run typecheck`：通过。
- `npm run compile`：通过。
- Chromium：`test:browser`、`test:browser:geometry`、`test:browser:inline`、`test:browser:inline-interaction`、`test:browser:footnote-caret`、`test:browser:typewriter`、`test:browser:arrow-scroll`、`test:browser:zoom`、`test:browser:math` 全部通过，且无页面错误；zoom 回归覆盖 Full 状态、resize、reopen、内置主题和无 `transform`。
- `npm run test:integration`：通过；本地 VS Code extension host 启动并完成 save-gated document-sync 回归。
