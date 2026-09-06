# Milestone: Repository Re-bootstrap

状态：已完成

## 目标

把已有的 Quarto Live Review Editor 仓库整理成可由人和代码代理持续维护的结构：明确三类意图文档、记录工程边界、补充仓库操作规则，并让文档、测试和 CI 保持一致。

## 变更

- 新增 [`docs/PRD.md`](../PRD.md)，统一产品目标、范围、非目标和用户验收行为。
- 新增 [`docs/EDD.md`](../EDD.md)，统一架构、数据流、Quarto 边界、安全约束和 CI 契约。
- 新增 [`docs/milestones/frontmatter-preview.md`](frontmatter-preview.md)，把已有 front matter 规格和已完成任务转换为执行意图。
- 新增根目录 [`AGENTS.md`](../../AGENTS.md)，说明文档权威性、验证命令、架构边界和安全规则。
- README 增加 canonical 文档入口；原 `specs/` 和 `doc/` 保留为历史设计资料，不删除、不覆盖。

## 验收标准

- [x] `docs/PRD.md`、`docs/EDD.md` 和 `docs/milestones/*.md` 存在且互相链接。
- [x] `AGENTS.md` 只包含仓库相关的操作规则和实际可执行命令。
- [x] README 中的安装、构建、测试命令与 package scripts/CI 一致。
- [x] 未新增项目 skill、MCP、插件或空架构目录；本次不需要额外 agent 基础设施。
- [x] 未修改现有产品行为、依赖版本或 Git 历史。
- [x] 工作区无未预期文件，未发现 tracked secret。
- [x] GitHub `main` 和 CI 状态在整理后重新核对。

## 验证命令

```powershell
npm ci
npm run typecheck
npm test
npm run compile
npm run test:browser
npm run test:browser:geometry
npm run test:browser:inline
npm run test:browser:inline-interaction
```
