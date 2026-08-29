---
title: 架构
description: 分层架构 —— L0 接入层 / L1 内核层 / L2 规程层 / L3 技能层，Seams、守卫管线、append-only 会话。
---

# 架构

AIH 分四层 + 一个横切面：

```
L3 技能层   skills/            按需加载的领域知识，可由 skill-creator 自进化
L2 规程层   APP.md · harness.yml · scripts · tasks · docs/decisions.md
L1 内核层   core/              SessionLog · ToolRegistry(守卫管线) · AgentLoop(turn/step) · Seams(LLM/权限)
L0 接入层   mcp-server/        AppAdapter: Context(读) / Action(写,带权限) / Event(流)
横切面       权限三档 allow/ask/deny · 审计日志 · eval 交接门禁
```

## L0 接入层（AppAdapter）

一个应用 = 一个适配器：`descriptor` + `context(query)` + `actions`。这是**唯一**的接入面，
`APP.md` 是唯一事实源。三种形态（MCP / CLI / SDK）都复用同一 L0 契约。

## L1 内核层（core/）

- **SessionLog**：append-only JSONL 事件流，"模型可见即可回放"；支持分叉/树/checkpoint 回滚
- **ToolRegistry（守卫管线）**：工具注册 + 权限守卫 + 钩子（脱敏/计时/审计）+ 并行只读调度
- **AgentLoop（turn/step）**：驱动一轮多步执行，`build/plan` 双模式，Goal 裁判，子代理
- **Seams**：可替换接缝——LLM 适配器（OpenAI 兼容/SSE）、沙箱后端、审批门、技能加载

## L2 规程层

`APP.md`（应用契约）、`harness.yml`（声明式配置）、`scripts/`（doctor/check/eval 门禁）、
`docs/decisions.md`（决策记录）。

## L3 技能层

SKILL.md 三级加载（project > user > builtin）+ BM25 相关性自动建议 + 外部 registry 安装。

## 横切面

- **权限三档** allow / ask / deny + pattern/路径作用域 + doom_loop + 密钥作用域
- **审计**：工具调用逐条落 `.aih/tool-audit.jsonl`（ok/error）
- **eval 交接门禁**：`npm run eval`（doctor + bootstrap + check + test）

## 关键设计决策

- **通用内核 + 应用工具**：内核不绑定任何业务，工具由 AppAdapter 注入
- **append-only**：会话/审计只追加，回滚=前缀分叉，崩溃可恢复
- **Seam 优先**：LLM/沙箱/审批/技能都是接缝，可插拔不锁死
- **判断与执行解耦**：Goal 裁判、best_of_n 裁判独立于执行代理

## 目录结构

```
core/        L1 内核（agent-loop / tool-registry / session-log / seams / prompts）
cli/         CLI + TUI + 本地工具（dev-tools / general-tools / sandbox / env-policy）
mcp-server/  L0 接入（app-adapter / todo-app 示例）
docs-site/   本站（独立包，marked 单依赖）
scripts/     doctor / check / eval / install / package
docs/        内部设计文档（roadmap / decisions / parity-matrix / test-plan）
```
