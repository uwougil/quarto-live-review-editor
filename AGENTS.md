# Repository Agent Guide

## Source of truth

- 产品意图：[`docs/PRD.md`](docs/PRD.md)
- 工程意图：[`docs/EDD.md`](docs/EDD.md)
- 执行意图：[`docs/milestones/`](docs/milestones/)
- `specs/frontmatter-preview/` 和 `doc/` 保存历史设计草稿，仅用于追溯；新的产品或工程决策应更新 `docs/` 中的 canonical 文档。

## Setup and verification

```powershell
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run compile
npm run test:browser
npm run test:browser:geometry
npm run test:browser:inline
npm run test:browser:inline-interaction
npm run test:browser:arrow-scroll
npm run test:browser:zoom
```

CI 在 Ubuntu/Node 22 上执行同一组核心检查，并在浏览器回归前编译 `dist/`。

## Issue-backed delivery

- GitHub Issue 是本次工作的 Work Contract；Issue-backed 修改使用隔离分支或 worktree，并通过 Pull Request 交付。
- PR 描述必须链接 Issue，说明变更范围、验收标准映射、验证命令/结果，以及对 PRD/EDD 的影响；这些信息应足以让另一位 agent 在没有私聊上下文的情况下接手。
- 必需验证未通过时不得合并。任何 PRD/EDD 语义变化都必须先由人明确决策；普通实现不得静默改写产品或工程意图。
- 交付前检查 `git status`、最终 diff、忽略文件和 tracked secrets；不要提交 `dist/`、`node_modules/`、VSIX、日志或机器专属文件。

## Architecture boundaries

- `src/extension.ts`、`src/editor/` 和 `src/sidebar/` 属于 VS Code 扩展宿主侧。
- `src/webview-editor/` 属于 CodeMirror 编辑器和渲染装饰层；不要把宿主 API 直接引入这里。
- `src/quarto/` 只负责轻量 Quarto 方言识别和源码安全的围栏/数学范围解析，不是完整 Quarto/Pandoc 执行器。
- `src/shared/` 放置宿主和 webview 都需要的纯逻辑。
- `dist/`、`node_modules/` 和 `.vsix` 是生成物或本地安装包，不应手工编辑或提交。

## Change and safety rules

- 保留原始 Markdown/Quarto 文本作为唯一事实来源；渲染 widget 不得覆盖磁盘源文本。
- 改动语法装饰、光标导航或几何测量时，至少运行对应的 Vitest 和真实 Chromium 回归；不要用 mock 替代关键浏览器交互。
- 所有本地资源访问必须继续受 VS Code `localResourceRoots` 和现有路径包含检查约束。
- 不提交 `.env`、密钥、token、cookie、机器专属路径或生成的私有数据。
- 不使用强制推送、历史重写或破坏性清理；当前发布远程为 `github`，上游远程为 `origin`。
- 修改用户意图时先更新 `docs/PRD.md`、`docs/EDD.md` 或相应里程碑，再实现代码。

## Issue and PR handoff

- Issue-backed changes normally use an isolated `codex/<issue>-<short-name>` branch or worktree and are delivered through a Pull Request; do not commit directly to `main`.
- The PR description must let another agent reconstruct the handoff from the linked Issue, PRD/EDD impact, commits and diff, verification commands/results, and CI status without private conversation state.
- Required verification must pass before merge. A PRD/EDD semantic change requires explicit human resolution and must be recorded in the canonical document.
