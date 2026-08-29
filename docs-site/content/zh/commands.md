---
title: 命令
description: 斜杠命令与 CLI 子命令速查 —— TUI 内 / 命令、aih 子命令、常用 flag。
---

# 命令

## TUI 斜杠命令

在交互终端输入 `/` 触发 Tab 幽灵补全。常用命令：

| 命令 | 用途 |
|---|---|
| `/help`（`/h`） | 帮助 |
| `/commands` | 列出全部命令 |
| `/mode` | 切换 build / plan 模式 |
| `/goal <条件>` | 设定目标，每轮独立裁判直至达成（`AIH_GOAL_ROUNDS` 封顶） |
| `/model <id>` | 热切换模型（`ctrl-p` 打开模型选择器） |
| `/models` | 列出 provider 与模型 |
| `/tools` | 列出当前可用工具 |
| `/usage` | token 用量 + 成本 + 缓存命中 |
| `/compact [focus]` | 主动压缩上下文（可带焦点） |
| `/clear` | 清空当前会话上下文 |
| `/inject <text>` | 注入一段提示 |
| `/events` | 查看事件流 |
| `/skills` | 技能管理 |
| `/find <text>` | 跨所有工具输出逐行检索 |
| `/tree` | 会话分支视图 |
| `/fork` | 从当前点分叉 |
| `/checkpoint [note]` | 记录检查点 |
| `/restore [seq]` | 回滚到检查点 |
| `/distill` | 分支蒸馏 |
| `/memory` | 持久记忆 |
| `/bg <prompt>` | 后台任务 |
| `/vivid` | 简洁渲染（去 chrome） |
| `/health` | 健康检查 |
| `/proc` | 进程视图 |
| `/quit`（`/exit`） | 退出 |

> 完整列表以 TUI 内 `/commands` 为准（随版本演进）。

## CLI 子命令

| 命令 | 用途 |
|---|---|
| `aih` | 启动交互终端（需 TTY） |
| `aih run "<msg>" [flags]` | 一次性问答 |
| `aih chat` | 交互会话 |
| `aih tools` / `aih describe` | 列出 / 描述工具 |
| `aih config` / `aih models` | 打印配置 / 列出 provider 与模型 |
| `aih session <list\|show\|rm\|export\|import\|fork\|checkpoint\|restore>` | 会话管理 |
| `aih stats` | 所有会话 token 用量 |
| `aih team <…>` | Agent Teams |
| `aih skills <…>` | 技能管理 |
| `aih workflow <list\|run>` | 确定性多阶段运行 |
| `aih init [dir]` | 脚手架新应用 |
| `aih serve --port N` | 无头 HTTP/SSE 服务 |
| `aih attach <url>` | 远程 attach |
| `aih mcp` | 以 stdio 提供内置 todo-app |
| `aih agents` | 列出命名 agent profile |
| `aih bench` | 性能基准 |

## 常用 flag

| flag | 用途 |
|---|---|
| `--mock` | 脚本化 LLM，离线演示/测试 |
| `-y, --yes` | 自动批准 ask 工具 |
| `--dev` | 一次性 `run` 挂载本地通用工具集（编程智能体） |
| `--no-dev` | `chat` 关闭默认本地工具集 |
| `--goal <条件>` | 裁判验证的自动续跑 |
| `-a, --as <name>` | 用命名 agent profile |
| `--session <name>` / `-c` | 命名会话 / 续跑最近会话 |
| `--ephemeral` | 关闭持久化 |
| `--no-stream` | 缓冲完整响应 |
| `--max-steps <n>` | 每轮最大步数 |
| `--debug-prompt` | 打印每次 LLM 调用的完整 messages |
| `-f, --format text\|json` | 输出格式（json = NDJSON 事件流） |
| `--no-audit` / `--no-redact` | 关闭审计 / 脱敏 |
