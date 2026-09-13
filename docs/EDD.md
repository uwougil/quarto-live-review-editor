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
│   ├── 处理光标、鼠标、键盘和主题更新
│   └── 协调可选的 Typewriter Mode 视口定位
├── src/webview-editor/livePreviewPlugin.ts
│   └── 行内标记、链接、图片、脚注和轻量视觉装饰
├── src/webview-editor/blockDecorations.ts
│   └── 表格、Mermaid、代码块等块级 widget
├── src/webview-editor/footnotes.ts
│   └── 脚注索引、引用/定义导航和隐藏源码交互保护
├── src/webview-editor/frontmatterWidget.ts
│   └── 文档首部 YAML front matter 检测、解析和 widget
├── src/webview-editor/documentZoom.ts
│   └── Live Preview 文档字号/阅读区宽度事件边界、快捷键和 CSS 状态
├── src/webview-editor/mathPasteHandler.ts
│   └── 粘贴时的 LaTeX 分隔符规范化（单次编辑事务内完成）
└── src/quarto/
    ├── dialect.ts：按路径区分 Markdown/Quarto
    ├── fence.ts：普通 Markdown 围栏与 Quarto/Pandoc 属性
    ├── math.ts：数学范围扫描和 StateField 缓存
    └── normalizeMathDelimiters.ts：粘贴片段的分隔符改写与受保护范围
```

## 3. 数据流与编辑模型

1. VS Code 通过 `MarkdownLivePreviewProvider` 创建 webview，并以消息发送文档文本、版本和主题 CSS。
2. webview 使用 CodeMirror `EditorState` 保存源文本、选区、语法树和 StateField。
3. `livePreviewPlugin` 和 `blockDecorationsField` 根据源位置生成 decoration/widget；widget 只改变显示，不改变文档内容。
4. 用户编辑产生 `ChangeSet`，webview 立即将 edit 发送回宿主，由同一文档 URI 的 `DocumentSyncCoordinator` 排队写入 VS Code 文档并向 origin 返回 ack；不使用固定 debounce 保证正确性。
5. 未保存的 webview edit 不广播给 sibling panel。`onWillSaveTextDocument` 等待 edit queue 和 change ack；`onDidSaveTextDocument` 成功后向所有 panel 广播带版本的完整 `savedSnapshot`。保存失败不广播 saved snapshot。
6. 普通源码编辑器产生的无 origin 变更是 host-authoritative external update，立即以增量发送到所有 panel；后续保存仍可发送 canonical snapshot。
7. 用户主题通过 `adaptMarkdownCss` 注入到独立 style 元素，并请求 CodeMirror 的测量流程，避免高度图过期。
8. `mdLivePreview.typewriterMode` 是宿主侧配置，打开 webview 时随 `init` 消息发送；配置变化通过 `typewriterModeChanged` 广播到所有活动会话。webview 只接收布尔状态，不直接读取 VS Code API。
9. 文档字号与正文阅读区宽度分别由扩展宿主的 `globalState` 独立共享持久化；webview 在根节点设置两个 CSS 自定义属性，并在任一值变化后的下一帧请求 CodeMirror 重新测量，保持行框、widget 和命中测试几何有效。

源位置是所有交互的身份：点击、脚注回跳、表格编辑、图片和图表操作都必须使用 CodeMirror 文档偏移或 DOM 到文档位置的 API，不使用屏幕像素推断文档位置。

### 3.1 文档同步与保存 barrier

- 每个文档 URI 只创建一个 `DocumentSyncCoordinator`，它串行化来自所有 panel 的 edit、history 和 host mutation。
- webview 的 `EditorSyncClient` 保留 confirmed、pending 和 in-flight ChangeSet；收到 sibling 的 saved snapshot 时按版本拒绝过期通知并保留未确认的本地输入。
- stale sibling 发送旧 `baseVersion` 时由 coordinator 拒绝并返回当前 host snapshot；该 panel 先把 host 变更映射到当前视图，再将自己的 in-flight/pending ChangeSet rebase 后重试。相同插入边界采用 host 变更在前、本地变更在后的确定性顺序。
- stale panel 的 save 请求在 `EditorSyncClient` 仍有 outstanding ChangeSet 时只排队，不发送给 host；只有 resync、rebase、retry 和 ack 全部完成后才发送 save，避免 host 先保存 A 而 B 的重试随后落地造成丢字。
- 任一 host-side save（包括 File/Command Palette/Auto Save 路径）在 `onWillSaveTextDocument` 中向该 URI 的所有已注册 peer 请求 save barrier；webview 先排空本地 ChangeSet、等待 host ack，再回传 barrier ack。coordinator 随后等待自己的 mutation queue 和延迟 change event 完成，才允许 native save 写盘；peer dispose、不可投递的 webview message 或 barrier 异常会确定性地解除对应等待，不阻塞其他 peer 的保存。
- save 是 sibling 同步 barrier，而不是逐字符协同编辑协议；origin panel 的本地视图和 VS Code native dirty state 可以先于 sibling 更新。

### 3.2 数学字体与局部 widget

- 数学渲染固定使用 KaTeX；`media/katex.min.css` 引用的 20 个 KaTeX face（woff2/woff/ttf）全部随扩展打包在 `media/fonts/`，webview CSP 只允许从自身资源源加载字体。
- KaTeX 保留自身的 glyph metrics、字重、TeX spacing 和 display style；扩展 CSS 只负责继承主题前景色、可测量的 display padding 和横向溢出，不替换数学字体或缩放整个 widget。
- KaTeX 字体完成加载后触发 CodeMirror 的 supported measurement；加载错误会写入 `data-mlp-katex-fonts="error"` 并记录错误，不静默接受浏览器 serif fallback。
- `MathWidget` 的等价性由公式内容与 inline/display 模式决定，不由易变的源码绝对偏移决定；鼠标交互通过当前 DOM 向 CodeMirror 查询最新偏移，因此单个公式编辑不会重建其余公式 DOM。

### 3.3 Typewriter Mode

- `src/webview-editor/typewriterMode.ts` 只负责编辑器视口控制，不创建文档变更，也不参与宿主同步。
- 写作型键盘事件、文本输入、删除、粘贴和拖放会安排一次下一帧定位；控制器使用 `coordsAtPos` 和 `scrollDOM` 的实际几何，把主光标中点尽量放到视口高度的 40%。
- 目标位置在文档开头或结尾不可达时使用 `scrollTop` 上下界钳制；文档短于视口时保持现有滚动位置。
- 鼠标/指针点击、滚轮、原生滚动和宿主驱动的 `jumpToLine`/`setCursor` 会暂停自动定位，避免和用户主动浏览或显式导航竞争。
- 控制器必须只挂在当前 `EditorView`，销毁时移除监听器；不得通过 `scrollIntoView` 事务制造二次编辑更新或同步循环。

### 3.3 粘贴时数学分隔符规范化

- 纯逻辑位于 `src/quarto/normalizeMathDelimiters.ts`，复用 `fence.ts` 的围栏扫描与 `math.ts` 的行内代码/既有数学掩码，不依赖 DOM，可在 Node 环境下由 Vitest 覆盖。
- webview 通过 `EditorView.domEventHandlers` 的 `paste` 处理器拦截并改写内容，改写与内置粘贴同属一次 `changeByRange` 派发：粘贴和规范化是同一个事务，宿主只收到一条 `edit`，一次 Undo 即可整体撤销。
- 只改写 `\(...\)` 与 `\[...\]` 两处分隔符，公式内部的空格、换行和 LaTeX 环境逐字保留；块公式统一为独占行的 `$$` 形式。
- 未命中（开关关闭、剪贴板不含 LaTeX 分隔符、改写后文本不变）时返回 `false`，完整交回 CodeMirror 内置粘贴，保留整行复制与「每选区一行」等既有语义。
- fenced code block、行内代码和既有 `$...$` / `$$...$$` 范围内的分隔符不改写；光标位于文档中已有围栏内时同样不改写，该判断基于源文本围栏扫描，不依赖语法树是否已解析到该位置。
- 找不到配对闭合符的开头分隔符按原样保留，避免生成孤立 `$` 把后续无关文本吞进数学范围。
- 改写走 `state.changeByRange`，因此每个选区都会得到同一份规范化文本。当前编辑器未启用 `EditorState.allowMultipleSelections`，CodeMirror 会把多选区折叠为单光标；改用多选区时该路径无需修改。

## 4. 装饰与源码回退规则

- 光标或非空选区触及语法范围时，相关装饰必须回退到源文本。
- 块级替换使用 `Decoration.replace({ widget, block: true })`；范围重叠前必须过滤，避免 CodeMirror `RangeSet` 的非重叠约束异常。
- 长文档只在可见范围创建脚注等 inline widget；视口语法解析使用有界的 `forceParsing`，不主动把整篇文档装入 DOM。
- 上下键使用 CodeMirror 的行移动/期望列语义；脚注保护只能修正候选文档位置，不能使用屏幕像素猜测。
- Typewriter Mode 的纯计算逻辑由 Vitest 覆盖；实际滚动、包裹行和主题/布局变化必须由真实 Chromium 回归覆盖，不能只用 jsdom 或 mock 视口证明。
- 生产 bundle 位于 `dist/`，由 esbuild 生成，不在源码审查中手工编辑。

## 5. Quarto 与 front matter 设计

本项目实现的是源码安全的轻量 Quarto 方言层，而不是 Quarto 渲染器：

- `.qmd` 通过 `documentDialect` facet 标记为 `quarto`；`.md` 标记为 `markdown`。
- 普通围栏和 Quarto/Pandoc brace info 统一由 `parseFenceInfo` 解析语言、类、ID、键值属性和位置参数。
- 代码单元只高亮和保持源码，不执行。
- front matter 由统一的行扫描规则检测：首行必须严格为 `---`，随后找到单独一行的 `---` 或 `...` 闭合行；文档中部同形内容不是 front matter。所有依赖 front matter 范围的消费者必须遵循这套终止规则。
- YAML 成功且有顶层键时显示 `mlp-frontmatter` 表格；空 YAML 使用零高度 widget；解析失败显示 `role="alert"` 错误 widget。
- front matter 范围与表格/代码块范围重叠时，块装饰遍历必须优先跳过重叠节点。
- front matter 的显示样式属于扩展基底 CSS，使用 VS Code CSS 变量，不纳入用户 Markdown CSS 主题改写。

### 5.1 文档字号与正文阅读区宽度缩放

- `documentZoom.ts` 是 Live Preview 根节点唯一的快捷键/滚轮事件 owner；只有其后代获得焦点时才处理输入，避免重复 keydown listener 造成一次输入执行两次。
- 文档字号范围为 70% 至 200%，默认值和步进均为 100%/10%；边界操作仍取消浏览器默认缩放，但不越界。
- 正文阅读区宽度范围为 60% 至 320%，默认值为 100%，全范围保持 10% 步进；`Ctrl/Mod +` 增大、`Ctrl/Mod -` 减小、`Ctrl/Mod + Shift + 0` 重置为 100%，边界操作仍取消浏览器默认缩放但不越界。
- `Ctrl/Mod`+滚轮只改变字号；`Ctrl/Mod + 0` 只重置字号。两套动作由同一个事件 owner 分派。
- 宿主分别通过 `mdLivePreview.documentZoomPercent` 和 `mdLivePreview.readingWidthPercent` 保存全局值，并向所有已打开的 `DocumentSyncSession` 广播；reading width 的状态为 60%–320% 的 10% 步进数值或持久化的 `full` 哨兵，320% 再增加进入 Full，Full 减少一次回到 320%；webview 的本地交互分别回传 `setZoom`/`setReadingWidth`。
- `adaptMarkdownCss` 仅在严格识别的 reading-column selector 上，把单一 finite CSS length 的 `max-width` 改写为乘以 `--mlp-reading-width`；百分比、`none`、viewport 单位、函数值、混合 selector 和无法安全解析的规则原样保留。没有 finite `max-width` 的主题不被基底 CSS 强制限制。
- Full 仅把适配器已经证明属于 reading column 的 finite `max-width` 通过 `--mlp-reading-column-max-width: none` 释放；未适配 selector 和不支持的宽度表达式不引用该变量，因而继续使用主题原值。根节点维持 viewport 响应式布局和侧边留白。
- 两个缩放值使用 CSS 自定义属性参与字体、间距或安全适配的列宽，不使用 `transform: scale`，不改变 CodeMirror 文档、选区或源文本；任一值变化后调用 `requestMeasure`。

详细的 feature 级验收和历史任务映射见 [`milestones/reading-width.md`](milestones/reading-width.md)。

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
npm run test:integration
npm run test:browser
npm run test:browser:geometry
npm run test:browser:inline
npm run test:browser:inline-interaction
npm run test:browser:typewriter
npm run test:browser:arrow-scroll
npm run test:browser:zoom
npm run test:browser:math
npm run test:browser:paste-math
```

CI 的 `Core` job 执行依赖安装、类型检查、单元测试和编译；`VS Code Extension Host Integration` job 使用真实 VS Code Extension Host、TextDocument、WorkspaceEdit 和保存事件执行同步契约；`Browser Regression` job 重新安装依赖、安装 Chromium、编译 webview bundle，再执行八个浏览器命令。浏览器回归必须使用真实 Playwright/Chromium，不得通过跳过步骤或降低断言来取得绿色状态。

## 8. Issue 与 PR 交付契约

GitHub Issue 是后续工作的持久 Work Contract，记录范围、验收条件和必要的产品/工程决策。Pull Request 是 Issue-backed 变更的标准 Delivery / Handoff Contract；它不是可选的提交包装，而是让人和其他代理在没有私有对话上下文时重建工作依据的主要交接记录。

正常生命周期为：

```text
Issue → 独立 branch/worktree → implementation → commit → push → PR
      → CI + task-local review → repair → merge → Issue closure
```

PR 至少应包含：

- 关联 Issue 和明确的变更范围；
- 本地验证命令及结果、对应 CI 状态和已知限制；
- 对 PRD/EDD 的影响说明；若改变产品或工程语义，必须先取得明确的人类决策并更新 `docs/` 中的 canonical 文档。

除仓库初始引导外，后续 Issue-backed 工作不应直接推送到 `main`。只有必需 CI 和 task-local review 通过后才能合并；`main` 表示已接受的实现现实。PR 模板见 [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md)。

## 9. 研究依据

以下是本次整理所依据的当前一手资料和项目实际配置：

- [VS Code CustomTextEditorProvider API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [CodeMirror 6 reference](https://codemirror.net/docs/ref/)
- [Quarto Markdown authoring](https://quarto.org/docs/authoring/markdown-basics.html)
- [`yaml` 官方仓库](https://github.com/eemeli/yaml)
- [Vitest 官方仓库](https://github.com/vitest-dev/vitest)
- [Playwright 官方仓库](https://github.com/microsoft/playwright)

2026-09-06 通过 npm registry 核对了 `yaml`、Vitest 和 Playwright 的仓库与许可证信息；项目继续以已提交 lockfile 和当前兼容性为准，不在本次文档整理中升级依赖。
