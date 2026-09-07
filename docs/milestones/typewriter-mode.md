# Milestone: Typewriter Mode

状态：已完成

## 来源与目标

- 来源：[GitHub Issue #14](https://github.com/uwougil/quarto-live-review-editor/issues/14)
- 目标：增加一个默认关闭的 Typewriter Mode，让用户在连续写作时把主光标保持在编辑器视口约 40% 的位置，同时不改变 Markdown/Quarto 源文本和既有导航语义。

## 实现映射

| 需求 | 实现 |
|---|---|
| 设置与侧栏开关 | `package.json` 的 `mdLivePreview.typewriterMode`、`src/sidebar/StyleManagerViewProvider.ts`、`src/webview-sidebar/main.ts` |
| 初始状态与实时切换 | `src/shared/messages.ts`、`src/editor/documentSync.ts`、`src/editor/MarkdownLivePreviewProvider.ts`、`src/webview-editor/main.ts` |
| 40% 目标、首尾钳制和短文档保持 | `src/webview-editor/typewriterMode.ts` |
| 用户滚动/点击和宿主导航优先 | `TypewriterModeController` 的用户操作暂停与 `main.ts` 的导航处理 |
| 单元回归 | `src/webview-editor/typewriterMode.test.ts` |
| Chromium 回归 | `scripts/long-document-browser-harness.html` 的 `--typewriter` 场景、`npm run test:browser:typewriter` |
| 产品与工程约束 | [`docs/PRD.md`](../PRD.md)、[`docs/EDD.md`](../EDD.md) |

## 验收标准

- [x] 设置默认关闭，并可从设置或侧栏切换。
- [x] 输入、删除、Enter、粘贴/拖放和上下移动光标会触发目标定位。
- [x] 光标中点尽量位于视口高度约 40%；文档首尾和短文档不会产生越界滚动。
- [x] 鼠标点击、滚轮滚动和宿主驱动的跳转不会被自动定位抢回。
- [x] Typewriter Mode 不创建文档变更，不改变宿主的编辑同步协议。
- [x] 纯计算逻辑已有 Vitest 覆盖。
- [x] CI 中的真实 Chromium 回归通过，并确认输入后 40% 定位和滚轮优先级没有回归。

## 验证记录

本地和 GitHub Actions 均已通过：

```powershell
npm run typecheck
npm test
npm run compile
npm run test:browser:typewriter
```

PR #23 的 CI 还通过了长文档、geometry、inline interaction 和 document zoom 浏览器回归。
