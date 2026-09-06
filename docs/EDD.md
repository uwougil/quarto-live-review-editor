# 工程设计文档（EDD）

状态：有效的工程意图来源

## 1. 技术基线

这是一个 VS Code 桌面扩展，使用 TypeScript、Node.js、CodeMirror 6、esbuild、Vitest 和 Playwright 构建。

| 项目 | 当前约束 |
|---|---|
| VS Code | `^1.90.0` |
| CI 运行时 | Node.js 22，Ubuntu `latest` |
| 包管理 | npm，提交 `package-lock.json`，CI 使用 `npm ci` |
| 构建 | `node esbuild.js`，同时生成扩展宿主和 webview bundle |
| 单测 | Vitest，Node 环境，`src/**/*.test.ts` |
| 浏览器回归 | Playwright + Chromium + 真实 CodeMirror `EditorView` |
| YAML | `yaml` npm 包，用于 front matter 解析 |

依赖选择遵循当前代码的最小职责边界：CodeMirror 负责编辑状态和视图，`@lezer/markdown` 负责 Markdown 语法树，`yaml` 只负责 YAML 解析，Shiki 负责代码高亮，Mermaid/draw.io 负责图表显示。不要因为 Quarto 是完整出版系统而把 Quarto CLI、Pandoc、Jupyter 或服务端运行时引入扩展运行时。

## 2. 系统边界与组件

```text
VS Code Extension Host
├── src/extension.ts
│   ├── 注册 MarkdownLivePreviewProvider（CustomTextEditorProvider）
│   ├── 管理 .md/.qmd 默认编辑器关联
│   ├── 管理 StyleStore、主题侧栏和文档大纲
│   └── 提供源码/预览切换命令
├── src/editor/
│   ├── 文档同步、编辑变更和 webview 消息
│   └── 扩展宿主与 webview 的资源/CSP 边界
└── src/sidebar/
    ├── CSS 主题管理
    └── 大纲视图

Webview Editor
├── src/webview-editor/main.ts
│   ├── 创建 EditorState/EditorView
│   ├── 安装 Markdown/GFM/Quarto 方言扩展
│   ├── 组合 inline 和 block decorations
│   └── 处理光标、鼠标、键盘和主题更新
├── src/webview-editor/livePreviewPlugin.ts
│   └── 行内标记、链接、图片、脚注和轻量视觉装饰
├── src/webview-editor/blockDecorations.ts
│   └── 表格、Mermaid、代码块等块级 widget
├── src/webview-editor/footnotes.ts
│   └── 脚注索引、引用/定义导航和隐藏源码交互保护
├── src/webview-editor/frontmatterWidget.ts
│   └── 文档首部 YAML front matter 检测、解析和 widget
└── src/quarto/
    ├── dialect.ts：按路径区分 Markdown/Quarto
    ├── fence.ts：普通 Markdown 围栏与 Quarto/Pandoc 属性
    └── math.ts：数学范围扫描和 StateField 缓存
```

## 3. 数据流与编辑模型

1. VS Code 通过 `MarkdownLivePreviewProvider` 创建 webview，并以消息发送文档文本、版本和主题 CSS。
2. webview 使用 CodeMirror `EditorState` 保存源文本、选区、语法树和 StateField。
3. `livePreviewPlugin` 和 `blockDecorationsField` 根据源位置生成 decoration/widget；widget 只改变显示，不改变文档内容。
4. 用户编辑产生 `ChangeSet`，经过短暂 debounce 后发送回宿主，由 `DocumentSyncSession` 写入 VS Code 文档。
5. 用户主题通过 `adaptMarkdownCss` 注入到独立 style 元素，并请求 CodeMirror 的测量流程，避免高度图过期。

源位置是所有交互的身份：点击、脚注回跳、表格编辑、图片和图表操作都必须使用 CodeMirror 文档偏移或 DOM 到文档位置的 API，不使用屏幕像素推断文档位置。

## 4. 装饰与源码回退规则

- 光标或非空选区触及语法范围时，相关装饰必须回退到源文本。
- 块级替换使用 `Decoration.replace({ widget, block: true })`；范围重叠前必须过滤，避免 CodeMirror `RangeSet` 的非重叠约束异常。
- 长文档只在可见范围创建脚注等 inline widget；视口语法解析使用有界的 `forceParsing`，不主动把整篇文档装入 DOM。
- 上下键使用 CodeMirror 的行移动/期望列语义；脚注保护只能修正候选文档位置，不能使用屏幕像素猜测。
- 生产 bundle 位于 `dist/`，由 esbuild 生成，不在源码审查中手工编辑。

## 5. Quarto 与 front matter 设计

本项目实现的是源码安全的轻量 Quarto 方言层，而不是 Quarto 渲染器：

- `.qmd` 通过 `documentDialect` facet 标记为 `quarto`；`.md` 标记为 `markdown`。
- 普通围栏和 Quarto/Pandoc brace info 统一由 `parseFenceInfo` 解析语言、类、ID、键值属性和位置参数。
- 代码单元只高亮和保持源码，不执行。
- front matter 由行扫描检测：首行必须严格为 `---`，随后找到单独的 `---` 闭合行；文档中部同形内容不是 front matter。
- YAML 成功且有顶层键时显示 `mlp-frontmatter` 表格；空 YAML 使用零高度 widget；解析失败显示 `role="alert"` 错误 widget。
- front matter 范围与表格/代码块范围重叠时，块装饰遍历必须优先跳过重叠节点。
- front matter 的显示样式属于扩展基底 CSS，使用 VS Code CSS 变量，不纳入用户 Markdown CSS 主题改写。

详细的 feature 级验收和历史任务映射见 [`milestones/frontmatter-preview.md`](milestones/frontmatter-preview.md)。

## 6. VS Code 资源和安全边界

- webview 使用 `default-src 'none'` 的 CSP，脚本通过 nonce 加载。
- `localResourceRoots` 只包含扩展的 `dist`、`media` 和当前文档目录；本地资源引用继续经过既有路径包含检查。
- Mermaid bundle 和 AWS shapes 作为按需资源加载，不把不必要的外部网络依赖放入 webview。
- 用户 CSS 是显示输入，不应获得扩展宿主权限；不要把 CSS、Markdown 或图表内容当作可执行配置。
- 仓库和测试中不得保存真实凭据、token、cookie、私钥或机器专属路径。

## 7. 测试与 CI 契约

核心命令：

```powershell
npm run typecheck
npm test
npm run compile
npm run test:browser
npm run test:browser:geometry
npm run test:browser:inline
npm run test:browser:inline-interaction
```

CI 的 `Core` job 执行依赖安装、类型检查、单元测试和编译；`Browser Regression` job 重新安装依赖、安装 Chromium、编译 webview bundle，再执行四个浏览器命令。浏览器回归必须使用真实 Playwright/Chromium，不得通过跳过步骤或降低断言来取得绿色状态。

## 8. 研究依据

以下是本次整理所依据的当前一手资料和项目实际配置：

- [VS Code CustomTextEditorProvider API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [CodeMirror 6 reference](https://codemirror.net/docs/ref/)
- [Quarto Markdown authoring](https://quarto.org/docs/authoring/markdown-basics.html)
- [`yaml` 官方仓库](https://github.com/eemeli/yaml)
- [Vitest 官方仓库](https://github.com/vitest-dev/vitest)
- [Playwright 官方仓库](https://github.com/microsoft/playwright)

2026-09-06 通过 npm registry 核对了 `yaml`、Vitest 和 Playwright 的仓库与许可证信息；项目继续以已提交 lockfile 和当前兼容性为准，不在本次文档整理中升级依赖。
