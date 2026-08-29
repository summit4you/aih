---
title: 开发
description: 开发 AIH 本身 —— 构建、测试、门禁、目录结构、贡献流程。
---

# 开发

AIH 是 TypeScript monorepo（`core/` 内核 · `cli/` CLI+TUI · `mcp-server/` 接入层），`docs-site/` 是独立包。

## 环境

- **Node.js ≥ 20**
- npm workspaces（`core` / `cli` / `mcp-server`）

## 常用命令

```sh
npm run bootstrap   # 安装依赖
npm run build       # tsc -b 构建三个 workspace
npm run doctor      # 环境与就绪检查
npm run check       # 构建 + 契约一致性校验
npm test            # 冒烟测试（core / mcp / cli）
npm run eval        # 完整交接门禁（doctor + bootstrap + check + test）
npm run cli -- <cmd>  # CLI：run / chat / tools / describe / sessions …
npm run bench       # AIH vs opencode 性能基准
```

## 交接门禁

完成任务前运行 `npm run eval` 作为交接门禁——它串联 doctor + bootstrap + check + test，全绿才算交付。

## 目录结构

```
core/        L1 内核（agent-loop / tool-registry / session-log / seams / prompts）
cli/         CLI + TUI + 本地工具（dev-tools / general-tools / sandbox / env-policy）
mcp-server/  L0 接入（app-adapter / todo-app 示例）
docs-site/   文档站（独立包，marked 单依赖）
scripts/     doctor / check / eval / install / package / bench
docs/        内部设计文档（roadmap / decisions / parity-matrix / test-plan）
```

## 变更规则

1. 新增/修改 Action 或 Context 时，必须同步更新：`APP.md` 第 4 节、`mcp-server/src/app-adapter.ts`、冒烟测试。
2. 破坏性变更需先在 `docs/decisions.md` 记录决策。
3. 完成任务前运行 `npm run eval` 作为交接门禁。

## 贡献流程

1. Fork + 分支
2. 本地 `npm run eval` 全绿
3. 提交 PR，附变更说明与（如适用）`docs/decisions.md` 决策记录
4. 维护者跑门禁后合并

## 文档站开发

`docs-site/` 是独立包（唯一依赖 `marked`）：

```sh
cd docs-site
npm run build   # content/{zh,en}/*.md → dist/
npm run check   # 校验两语言 nav↔content 1:1、链接、资源
```

内容在 `content/zh/` 与 `content/en/`，各自 `_nav.json` 为导航单一事实源；所有内部链接用相对路径，便于 GitHub Pages 子路径部署。
