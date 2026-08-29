---
title: 快速开始
description: 三种接入形态快速上手 —— MCP 外挂、CLI 接入、内嵌 SDK，附 todo 示例。
---

# 快速开始

AIH 自带一个 todo 应用作为示例适配器，下面用它演示三种接入形态。

## 形态一：MCP 外挂（零侵入，推荐起步）

把 AIH 的工具挂进任何 MCP 客户端（opencode / codex / claude code）：

```json
{
  "mcpServers": {
    "todos": {
      "command": "node",
      "args": ["/绝对路径/aih/mcp-server/dist/index.js"]
    }
  }
}
```

客户端即可调用 `list_todos` / `add_todo` / `toggle_todo` / `remove_todo`，
AIH 负责权限、审计与会话。

## 形态二：CLI 接入

```sh
# 交互终端（opencode 风格 TUI，需 TTY）
aih

# 一次性问答（离线演示，无需 API key）
npm run cli -- run "add a todo buy milk" --mock

# 真实模型（任意 OpenAI 兼容接口，SSE 流式）
AIH_BASE_URL=https://api.deepseek.com/v1 \
AIH_MODEL=deepseek-chat \
AIH_API_KEY=sk-... npm run cli -- run "今天有哪些待办？"

# 会话持久化：--session 指定名称，-c 续跑最近会话
npm run cli -- run "添加待办A" --session work
npm run cli -- run "再添加B" -c
```

**常用子命令**：

| 命令 | 用途 |
|---|---|
| `aih tools` / `aih describe` | 列出工具 / 描述工具（与 `APP.md` 第 4 节一致） |
| `aih config` / `aih models` | 打印生效配置 / 列出所有 provider 与模型 |
| `aih session list\|show\|export\|fork\|checkpoint\|restore` | 会话管理 |
| `aih skills list\|find\|install\|show` | 技能管理 |
| `aih stats` | 所有会话 token 用量汇总 |
| `aih serve` / `aih attach` | 无头服务 / 远程 attach |

## 形态三：内嵌 Copilot（SDK）

直接复用 L1 内核，把业务工具注册进 `AgentLoop`：

```js
import { AgentLoop, ToolRegistry } from "@aih/core";

const registry = new ToolRegistry();
registry.register({
  name: "get_order",
  description: "读取订单状态",
  kind: "read",
  permission: "allow",
  run: async (args) => myApp.getOrders(args.id),
});
// …… 把 registry 交给 AgentLoop，即可驱动一个内嵌智能体
```

## 写操作确认

写操作默认需确认：

- **TTY**：`[y/N]` 提示
- **非 TTY**：须显式 `--yes`，否则拒绝执行

```sh
npm run cli -- run "删除待办 #3" --yes   # 脚本管道中显式放行
```

## 下一步

- 配置 provider 与模型 → [配置](config)
- 接入你自己的应用 → [接入你的应用](adapter)
- 了解权限模型 → [权限](permissions)
