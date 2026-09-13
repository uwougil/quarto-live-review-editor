# Milestone: Typewriter Mode

状态：Issue #27 已完成（本地与 GitHub CI 验证通过）

## 来源与目标

- 来源：[GitHub Issue #14](https://github.com/uwougil/quarto-live-review-editor/issues/14) 的实现，以及 [Issue #27](https://github.com/uwougil/quarto-live-review-editor/issues/27) 的产品 follow-up
- 目标：提供默认开启、可关闭的 Typewriter Mode，让用户在连续写作或普通单击定位后把主光标保持在编辑器视口约 50% 的位置，同时不改变 Markdown/Quarto 源文本和既有导航语义。

## 实现映射

| 需求 | 实现 |
|---|---|
| 设置与侧栏开关 | `package.json` 的 `mdLivePreview.typewriterMode`、`src/sidebar/StyleManagerViewProvider.ts`、`src/webview-sidebar/main.ts` |
| 初始状态与实时切换 | `src/shared/messages.ts`、`src/editor/documentSync.ts`、`src/editor/MarkdownLivePreviewProvider.ts`、`src/webview-editor/main.ts` |
| 50% 目标、首尾钳制和短文档保持 | `src/shared/typewriterMode.ts`、`src/webview-editor/typewriterMode.ts` |
| 单击恢复与拖选区分 | `TypewriterModeController` 的 pointer gesture discrimination |
| 用户滚动和宿主导航优先 | `TypewriterModeController` 的用户操作暂停与 `main.ts` 的导航处理 |
| 单元回归 | `src/webview-editor/typewriterMode.test.ts` |
| Chromium 回归 | `scripts/long-document-browser-harness.html` 的 `--typewriter` 场景、`npm run test:browser:typewriter` |
| 产品与工程约束 | [`docs/PRD.md`](../PRD.md)、[`docs/EDD.md`](../EDD.md) |

## 验收标准

- [x] 设置默认开启，并可从设置或侧栏关闭。
- [x] 输入、删除、Enter、粘贴/拖放和上下移动光标会触发目标定位。
- [x] 光标中点尽量位于视口高度约 50%；文档首尾和短文档不会产生越界滚动。
- [x] 普通单击立即定位；拖选、滚轮滚动和宿主驱动的跳转不会被自动定位抢回。
- [x] Typewriter Mode 不创建文档变更，不改变宿主的编辑同步协议。
- [x] 纯计算逻辑已有 Vitest 覆盖。
- [x] 本地真实 Chromium 回归通过，并确认单击、拖选、50% 定位和滚轮优先级没有回归；PR #60 的 GitHub required checks 已全部通过。

## 验证记录

Issue #27 验证记录：

- 更新基线：`github/main` / `ce71eb69a3a63c7ed3bb1d75f7ec1ccad015793c`
- CI 验证提交：`609b719fec4950824d574a9a92913ea3aadd71cf`

```powershell
npm run typecheck
npm test
npm run compile
npm run test:integration
npm run test:browser
npm run test:browser:geometry
npm run test:browser:inline
npm run test:browser:inline-interaction
npm run test:browser:footnote-caret
npm run test:browser:typewriter
npm run test:browser:arrow-scroll
npm run test:browser:zoom
npm run test:browser:math
npm run test:browser:paste-math
```

本地结果：`npm ci`、Chromium 安装、类型检查、526 个单元测试、编译、集成测试及上述全部浏览器回归均通过；Typewriter 场景的 18 项检查全部通过。

GitHub Actions run `34766823464`：`Core`、`VS Code Extension Host Integration`、`Browser Regression` 均为 success。
