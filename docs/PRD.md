# 产品需求文档（PRD）

状态：有效的产品意图来源

## 1. 产品概述

Quarto Live Review Editor 是一个 VS Code 扩展，为 Markdown 和 Quarto (`.qmd`) 文档提供单栏实时渲染编辑体验。用户在同一编辑区域中看到接近最终文档的排版，同时可以通过光标、选区和键盘随时回到原始 Markdown/Quarto 源码。

磁盘中始终保存用户的原始文本。渲染结果是编辑器视图层，不是对源文件的替换。

## 2. 用户与结果

主要用户是使用 VS Code 编写科研日志、论文、Quarto 笔记和技术文档的用户，尤其需要数学公式、代码单元、引用、脚注、表格和图表的用户。

用户应能：

- 直接打开 `.md` 或 `.qmd` 并获得可编辑的实时预览；
- 在不离开当前编辑器的情况下编辑原始语法；
- 使用 Quarto/Pandoc 常见语法而不被错误改写；
- 通过 VS Code 主题和内置 CSS 主题获得稳定、可读的排版；
- 在长文档中滚动、定位、编辑，并保持光标和布局稳定。

## 3. 产品目标

### 3.1 当前目标

1. 提供 `.md` 和 `.qmd` 的单栏实时编辑器。
2. 渲染常用 Markdown/GFM 内容：标题、强调、列表、任务列表、链接、图片、表格、脚注、数学、Mermaid 和 draw.io。
3. 支持 Quarto 围栏代码单元、Pandoc 属性和科学写作中的源码安全回退。
4. 将文档开头的 YAML front matter 显示为可读表格，并在需要编辑时恢复源码。
5. 提供 VS Code、Dark、GitHub Light、GitHub Dark 和 Claude 内置主题，以及用户 CSS 主题管理。
6. 通过单元测试和真实 Chromium 回归测试保护长文档、几何布局和交互行为。

### 3.2 非目标

当前版本不执行 Quarto 文档，不启动 Jupyter/kernel，不调用 Pandoc 或 Quarto CLI，不实现 citation 渲染、cross-reference 解析、callout 渲染、shortcode 展开或 Typst 渲染。上述内容应保持源码安全，而不是伪装成已渲染结果。

## 4. 功能需求

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-1 | 扩展必须注册 Markdown 和 Quarto 自定义编辑器，并支持在源码编辑器与实时预览之间切换。 | P0 |
| FR-2 | 光标或选区进入被渲染的语法范围时，必须显示可编辑源码；离开后恢复渲染。 | P0 |
| FR-3 | 常用 Markdown/GFM 元素必须保持源文本安全，并在单栏中提供相应的视觉表示。 | P0 |
| FR-4 | Quarto 围栏（包括 ` ```{python} `、` ```{r} `、` ```{julia} ` 和属性形式）必须被统一识别并高亮，但不执行。 | P0 |
| FR-5 | 文档首行严格为 `---`、且存在单独一行的闭合 `---` 或 `...` 时，必须识别 front matter；有效键值显示为表格，空内容不显示表格，非法 YAML 显示错误。 | P0 |
| FR-6 | 数学公式、表格、Mermaid、draw.io、脚注、链接和图片必须保留可编辑回退路径，并维持有效的鼠标/键盘导航。 | P0 |
| FR-7 | 用户 CSS 主题和 VS Code 颜色主题必须能影响编辑器外观，而不破坏文档几何和源码交互。 | P1 |
| FR-8 | 大文档必须使用视口化渲染和受控的语法解析，不能因打开文档而无条件解析整篇文档或创建全量 DOM。 | P0 |
| FR-9 | 扩展必须提供文档大纲、图片粘贴、表格编辑和实时保存能力。 | P1 |

## 5. 可接受行为

- `.qmd` 文件默认可通过 `Quarto Live Review` 打开；用户可以在设置中选择始终使用实时预览、始终使用普通编辑器或提示选择。
- 初始打开 front matter 文档时应直接显示表格；点击或将光标移入表格范围后可编辑原始 YAML。
- 缺失或重复脚注定义、代码围栏、行内代码、未实现的 Quarto 扩展语法不得被错误地转换为虚假渲染结果。
- 主题切换、长段落软换行、上下键移动和脚注定位不得造成光标跳跃、隐藏源码意外展开或 CodeMirror 几何异常。
- 保存后文件内容必须仍是用户输入的 Markdown/Quarto 源文本。

## 6. 约束与验收入口

- 支持的运行时和验证命令以 [`docs/EDD.md`](EDD.md) 与 [`AGENTS.md`](../AGENTS.md) 为准。
- 当前已完成的 front matter 功能验收记录在 [`docs/milestones/frontmatter-preview.md`](milestones/frontmatter-preview.md)。
- 仓库再整理的验收记录在 [`docs/milestones/2026-09-repository-rebootstrap.md`](milestones/2026-09-repository-rebootstrap.md)。
