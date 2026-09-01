---
title: 简介
description: AIH（App Intelligence Harness）——让任意普通应用通过标准化接入获得 AI 能力的通用框架。
---

# 简介

**AIH（App Intelligence Harness）** 把"应用接入智能体"这件事标准化：实现一个轻量的
`AppAdapter`（读 Context / 写 Action / 收 Event），你的业务应用就获得了
allow/ask/deny 三级权限、append-only 会话审计、可插拔技能层与三种接入形态
（MCP 外挂 / CLI / 内嵌 SDK）——**不需要改动任何业务代码**。

AIH 是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 与
[opencode](https://github.com/anomalyco/opencode) 设计思想的融合体：前者贡献了
append-only Session Log、守卫式工具管线与可替换能力接缝（Seam），后者贡献了
build/plan 双模式、权限模型、技能层与 TUI 交互范式。

## 核心理念

| 理念 | 含义 |
|---|---|
| **AppAdapter** | 一个应用 = 一个适配器：`descriptor` + `context(query)` + `actions`，三个原语即可接入 |
| **L0 契约** | `Context`（读）/ `Action`（写）/ `Event`（变更流）是唯一的接入面，`APP.md` 是唯一事实源 |
| **三级权限** | `allow` 直接执行 · `ask` 经审批门确认 · `deny` 注册表直接拒绝 |
| **append-only 审计** | 会话是逐行 JSONL 事件流，"模型可见即可回放"，工具调用另落审计日志 |
| **可替换 Seam** | LLM 适配器、沙箱后端、审批门、技能加载都是接缝，可插拔不锁死 |

## 三种接入形态

| 形态 | 场景 | 入口 |
|---|---|---|
| **MCP 外挂**（零侵入，推荐起步） | 挂进 opencode / codex / claude code 等任何 MCP 客户端 | `mcp-server/dist/index.js` |
| **CLI 接入** | 交互终端、一次性问答、脚本管道 | `aih` / `aih run` / `aih chat` |
| **内嵌 Copilot**（SDK） | 直接复用 L1 内核，把工具注册进 `AgentLoop` | `@aih/core` |

## 实际运行

打开交互终端（opencode 风格 TUI），输入一句话，模型即调用应用工具。下面是一次
**真实运行**的终端截图（`--mock` 离线演示，无需 API key）——模型规划、调用
`add_todo`、返回结果，右侧是实时上下文用量，底部是状态栏：

<figure>
  <img src="assets/aih-tui.png" alt="AIH 交互终端运行截图：输入 add a todo buy milk，模型调用 add_todo 工具并返回 Added via mock" loading="lazy">
  <figcaption>AIH 交互终端 —— 一句话驱动 <code>add_todo</code> 工具，实时上下文用量与状态栏</figcaption>
</figure>

> 这张图是对真实 TUI 输出的逐格截图（PTY + 终端仿真），非手绘示意。
> 一次性问答形态见 [`aih run`](quickstart)。

## 特性亮点

- **通用 agent 内核**：工具来自外接应用；交互终端默认再挂一套本地通用工具（文件/命令/搜索/网页）
- **build / plan 双模式**：plan 只读分析，全部写工具从注册表隐藏
- **Goal 裁判**：`/goal <条件>` 每轮结束独立 LLM 裁判，防"乐观停止"
- **子代理体系**：`task` 串行子代理 + `best_of_n` 并行裁判（Max Mode）+ Agent Teams
- **技能层**：SKILL.md 三级加载（project > user > builtin）+ BM25 相关性自动建议
- **会话管理**：持久化 / 分叉 / 树结构 / checkpoint 回滚 / 分支蒸馏
- **上下文管理**：主动+被动+手动压缩、coverage 投影式 checkpoint、工具结果修剪归档
- **成本观测**：内置价目表 + 会话成本/TPS + 缓存命中归因
- **安全**：子进程 env 密钥过滤、密钥仅发往属主端点、项目信任门、BOM 容错

## 下一步

- 想系统学一遍 AIH → **《AIH 入门与源码深挖》**（五部十八章教程，[从导读开始](tutorial/index)）
- 想立刻上手 → [安装](install)
- 想看完整示例 → [快速开始](quickstart)
- 想接入自己的应用 → [接入你的应用](adapter)
