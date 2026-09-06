# Milestone: Front Matter Preview

状态：已完成

## 目标

把文档首部 YAML front matter 从原始 `---`/YAML 文本显示为可读表格，同时保留点击、光标和选区进入源码的编辑路径，并与既有块级装饰体系兼容。

## 范围

- 只识别文档第 1 行开始、由单独闭合行结束的 front matter。
- 解析顶层键值；标量、标量数组和嵌套对象都要可读显示。
- 空 YAML 不绘制可见表格，非法 YAML 显示错误。
- 与表格、围栏代码和其他 block decoration 保持非重叠。
- 主题颜色使用扩展基底 CSS 的 VS Code 变量。
- 初始打开时把选区放到 front matter 之后，避免初始光标位置阻止 widget 显示。

## 实现映射

| 需求 | 实现 |
|---|---|
| 首行和闭合行检测 | `src/webview-editor/frontmatterWidget.ts` 的 `detectFrontmatter` |
| YAML 解析和三种显示状态 | `FrontmatterWidget`、`FrontmatterEmptyWidget`、`FrontmatterErrorWidget` |
| 块级装饰和重叠保护 | `src/webview-editor/blockDecorations.ts` |
| 行内装饰跳过 | `src/webview-editor/livePreviewPlugin.ts` |
| 基础样式 | `media/webview-editor-theme.css` |
| 初始选区修正 | `src/webview-editor/main.ts` 的 initial state 构建逻辑 |
| 单元测试 | `src/webview-editor/frontmatterWidget.test.ts` |
| 浏览器验收 | `scripts/run-long-document-browser-test.mjs` 的 inline fixture |

## 验收标准

- [x] 只识别文档首部 front matter，文档中部同形内容保持普通 Markdown。
- [x] 普通键值显示为表格。
- [x] 空 front matter 不显示空表格。
- [x] 非法 YAML 显示错误提示。
- [x] 数组和嵌套映射以可读形式显示。
- [x] 点击或移动光标进入 front matter 后可以编辑原始 YAML。
- [x] 主题变化不破坏 front matter 样式或布局。
- [x] 初始打开即显示表格，不要求用户先移动光标。

## 验证记录

已运行并通过：

```powershell
npm run typecheck
npm test
npm run compile
npm run test:browser:inline
npm run test:browser:inline-interaction
npm run test:browser:geometry
```

完整仓库验证和 CI 运行记录见 [`2026-09-repository-rebootstrap.md`](2026-09-repository-rebootstrap.md)。
