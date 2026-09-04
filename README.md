# Quarto Live Review Editor

一个在 VS Code 中提供单栏即时渲染编辑体验的 Markdown/Quarto 扩展。项目来源于并基于原 [Markdown Live Preview Editor](https://github.com/t-shoot/md-live-preview-editor)，当前 fork 重点增强 Quarto 科研写作工作流。编辑区域会根据光标位置在渲染结果和源码之间切换，磁盘中始终保存原始文本。

## 主要功能

- 支持 `.md` 和 `.qmd` 文件。
- 标题、强调、引用、列表、任务列表、链接、图片和表格的单栏实时预览。
- 使用本地 KaTeX 渲染行内公式 `$...$` 和块公式 `$$...$$`。
- 光标或选区进入公式、表格、图表等区域时恢复源码编辑。
- Mermaid 和 draw.io 图表原地渲染。
- 表格单元格原地编辑、行列添加和源码安全保存。
- 代码块语法高亮、图片粘贴、文档大纲和 CSS 主题管理。
- 内置 CSS 主题：VS Code、Dark、GitHub Light、Claude 和 GitHub Dark；主题之间互相独立，可在侧栏切换。
- ` ```{python} `、` ```{r} `、` ```{julia} ` 和 ` ```{.python} ` 使用统一的 Quarto/Pandoc 围栏解析入口，并交给现有 Shiki 高亮体系。

## 安装开发版

```powershell
npm install
npm run compile
```

在 VS Code 中打开仓库并按 `F5`，即可启动 Extension Development Host。然后打开：

```text
examples/quarto-live-preview.qmd
```

也可以打包并安装本地 VSIX：

```powershell
npm run vscode:prepublish
npx vsce package
code --install-extension .\markdown-live-preview-editor-0.0.12.vsix --force
```

## Quarto 使用

打开 `.qmd` 文件后，扩展会自动使用 Live Preview。示例：

```qmd
Berry curvature is $\Omega_n(\mathbf{k})$.

$$
E = \hbar \omega
$$
```

光标离开公式时显示渲染结果；点击公式或将选区移入公式时显示原始 `$` 语法。编辑和保存不会把公式替换成 HTML、Unicode 或 KaTeX 输出。

Quarto 特有的 callout、shortcode、citation、cross-reference 和代码单元目前保持源码安全，不会被错误改写；代码单元只负责识别和高亮，暂不执行。

## 语法架构

轻量语法层位于 `src/quarto/`：

- `dialect.ts`：区分 Markdown 与 Quarto 文档。
- `fence.ts`：统一解析普通 Markdown 围栏、Quarto 代码单元和 Pandoc 属性。
- `math.ts`：使用原始文档偏移解析数学公式，并通过 CodeMirror 状态字段缓存范围。

这不是完整 Quarto/Pandoc 解析器。未来的 callout、citation、cross-reference 和代码单元 UI 可以在该边界上逐步扩展，同时保留源码作为唯一事实来源。

数学范围只在文档创建时全文扫描；普通的不含 `$` 或反引号的编辑会映射缓存范围，可能改变公式语义的编辑则安全地回退到全文扫描。光标/选区移动和视口变化只复用缓存，因此不会触发数学解析。

多行 `$$...$$` 使用 StateField 提供的块装饰，避免把会吞掉换行的替换装饰放进 ViewPlugin；编辑器仍按视口虚拟化 DOM。视口解析只通过有时间上限的 `forceParsing` 追到当前视口末端，不会打开文档时主动解析整篇文档。

## 设置

| 设置 | 说明 |
|:---|:---|
| `mdLivePreview.codeTheme` | 代码高亮主题：`auto`、`dark-plus`、`light-plus`、`github-dark`、`github-light`。 |
| `mdLivePreview.enabledStyles` | 当前启用的 CSS 主题。 |
| `mdLivePreview.defaultEditor` | `prompt` 使用普通编辑器，`livePreview` 默认使用实时预览，`default` 使用普通编辑器。 |

## 测试

```powershell
npm run typecheck
npm test
npm run compile
npm run test:browser
```

Quarto 示例位于 [examples/quarto-live-preview.qmd](examples/quarto-live-preview.qmd)，科研回归 fixture 位于 [examples/quarto-scientific.qmd](examples/quarto-scientific.qmd)。

`npm run test:browser` 会启动真实 Chromium 和真实 CodeMirror `EditorView`，默认使用仓库内确定性的 realistic fixture，不依赖其他仓库或本机目录。fixture 覆盖前置元数据、标题、长段落、Unicode/CJK、行内/多行块公式、围栏代码、Quarto 代码单元、表格、Mermaid、链接、图片、引用和脚注。测试会滚动到 0%、25%、50%、75%、90%、99% 和 EOF，并检查文档长度、视口、滚动高度、语法树覆盖范围及实际 DOM 内容；`--source path/to/file.qmd` 可显式指定仓库内的其他夹具。使用 `python scripts/run-long-document-browser-test.py --benchmark` 可记录 1k、5k、10k、20k 行文档的就绪、滚动和 EOF 耗时、DOM 行数、装饰重建数、长任务及页面错误。

## 当前限制

尚未实现 Quarto 代码执行、Jupyter/kernel、citation 渲染、cross-reference 解析、callout 渲染、shortcode 展开、Typst、Pandoc 子进程和 Quarto CLI 渲染；这些语法会保留为源码安全回退。

扩展标识仍保留原来的 `name` 和 `publisher`，以避免已安装的 VSIX 标识发生破坏性变化；Marketplace 发布者 `t-shoot` 也未被伪造或更换。仓库、问题反馈地址和主页已指向当前 fork。

## 许可

源代码使用 MIT License。AWS 图形数据的许可条件见 [LICENSE-SHAPES](LICENSE-SHAPES) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
