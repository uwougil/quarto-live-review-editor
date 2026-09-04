---
title: Quarto Live Review 使用示例
tags:
  - markdown
  - live-preview
  - quarto
---

# Quarto Live Review Editor

这是一个可以保持渲染外观并直接编辑的 Markdown/Quarto 实时预览扩展。

光标离开时显示格式化结果，进入对应区域时显示原始 Markdown；保存到磁盘的始终是纯文本。

## 主要功能

- 单栏实时预览编辑
- 支持 `.md` 和 `.qmd`
- 代码块语法高亮
- Mermaid 和 draw.io 图表原地渲染
- KaTeX 数学公式渲染
- 表格和 CSS 主题管理

## 安装和使用

1. 在 VS Code 中打开文件。
2. 打开 `.md` 或 `.qmd` 文件。
3. 扩展会自动使用 Live Preview。
4. 点击公式或渲染块即可恢复源码编辑。

## 数学公式

行内公式：$\Omega_n(\mathbf{k})$。

块公式：

$$
E = \hbar \omega
$$

## 代码示例

```python
def square(x: int) -> int:
    """返回一个数的平方。"""
    return x ** 2
```

## 工作原理

```mermaid
flowchart LR
    A[打开 Markdown 或 Quarto 文件] --> B{光标是否进入语法区域?}
    B -- 是 --> C[显示原始源码]
    B -- 否 --> D[显示渲染结果]
    C --> E[保存原始文本]
    D --> E
```

## 表格测试

| 名称 | 备注 | 状态 |
|:---|:---|:---|
| Alice |  | OK |
|  | 待处理 | NG |
| Bob | 已完成 |  |

## Quarto 代码单元

```{python}
import numpy as np

k = np.linspace(-1, 1, 100)
```

当前版本只显示 Quarto 代码单元，不执行其中的代码。
