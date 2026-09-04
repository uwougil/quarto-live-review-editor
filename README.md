# Quarto Live Review Editor

一个在 VS Code 中提供单栏即时渲染编辑体验的 Markdown/Quarto 扩展。编辑区域会根据光标位置在渲染结果和源码之间切换，磁盘中始终保存原始文本。

## 主要功能

- 支持 `.md` 和 `.qmd` 文件。
- 标题、强调、引用、列表、任务列表、链接、图片和表格的单栏实时预览。
- 使用本地 KaTeX 渲染行内公式 `$...$` 和块公式 `$$...$$`。
- 光标或选区进入公式、表格、图表等区域时恢复源码编辑。
- Mermaid 和 draw.io 图表原地渲染。
- 表格单元格原地编辑、行列添加和源码安全保存。
- 代码块语法高亮、图片粘贴、文档大纲和 CSS 主题管理。

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

Quarto 特有的 callout、shortcode、citation 和代码单元目前保持源码安全，不会被错误改写；Python 代码单元暂不执行。

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
```

当前 Quarto 数学预览 fixture 位于 [examples/quarto-live-preview.qmd](examples/quarto-live-preview.qmd)。

## 许可

源代码使用 MIT License。AWS 图形数据的许可条件见 [LICENSE-SHAPES](LICENSE-SHAPES) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
