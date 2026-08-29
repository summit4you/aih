---
title: 接入你的应用
description: 用 AppAdapter 把任意应用接入 AIH —— L0 契约（Context/Action/Event）、APP.md、权限标注。
---

# 接入你的应用

AIH 的核心差异：**不改动业务代码**，只实现一个轻量的 `AppAdapter`。一个适配器
= `descriptor`（应用描述）+ `context(query)`（读状态）+ `actions`（写动作，参数用
zod 定义）。

## L0 契约：三个原语

| 原语 | 含义 | 权限 |
|---|---|---|
| **Context** | 读操作，返回业务状态快照 | `allow`，直接执行 |
| **Action** | 写操作，改变业务状态 | `allow` / `ask` / `deny` |
| **Event** | 变更事件流（可选） | 只读 |

接入面是**唯一**的——`APP.md` 是该应用对智能体的**唯一事实源**，任何接入的智能体
（opencode / codex / claude / 自建 copilot）都必须先读它。

## 写一个适配器（示意）

```ts
import { z } from "zod";

export const myAppAdapter = {
  descriptor: {
    name: "orders",
    description: "订单管理应用：查询/创建/取消订单",
    // …… 领域术语、能力边界（见 APP.md 第 2、3 节）
  },

  // 读：Context（allow）
  context: async (query) => {
    if (query === "all")    return myApp.listOrders();
    if (query === "stats")  return myApp.orderStats();
    throw new Error(`unknown context query: ${query}`);
  },

  // 写：Action（带权限标注）
  actions: [
    {
      name: "create_order",
      description: "创建订单",
      kind: "write",
      permission: "ask",                 // 需人工/策略确认
      args: z.object({
        item: z.string().min(1),
        qty: z.number().int().positive(),
      }),
      run: async (a) => myApp.createOrder(a),
    },
    {
      name: "cancel_order",
      description: "取消订单（业务红线，直接拒绝）",
      kind: "write",
      permission: "deny",
      args: z.object({ id: z.string() }),
      run: async () => { throw new Error("denied by policy"); },
    },
  ],

  // 变更事件（可选）
  events: ["order.created", "order.cancelled"],
};
```

## APP.md：唯一事实源

每个接入应用都应有一份 `APP.md`（借鉴 Harness-for-codex 的 AGENTS.md 模式），包含：

1. **应用概述** — 名称、一句话描述、技术栈
2. **领域术语** — 业务词汇表
3. **能力边界** — 允许（allow）/ 需确认（ask）/ 禁止（deny）
4. **接入原语清单（L0）** — Context / Action / Event 与各自的权限
5. **标准命令** — doctor / check / test / eval / cli 约定

> 保持 `APP.md` 与 `harness.yml` 和实际代码一致；不一致时以实际代码为准并立即更新。

## 权限标注

每个 Action 标注 `permission`：

| 档位 | 行为 | 典型对象 |
|---|---|---|
| `allow` | 直接执行 | 读操作 |
| `ask` | 经 `ApprovalGate` 人工/策略确认 | 写操作（删除、发布、支付） |
| `deny` | 注册表直接拒绝 | 业务红线（改凭据、越权） |

详见 [权限](permissions)。

## 接入形态

| 形态 | 入口 | 说明 |
|---|---|---|
| **MCP 外挂**（推荐起步） | `mcp-server/dist/index.js` | 零侵入，挂进任何 MCP 客户端 |
| **CLI 接入** | `aih` / `aih run` / `aih chat` | 交互终端、一次性问答、脚本管道 |
| **内嵌 Copilot** | `@aih/core` | 复用 L1 内核，把工具注册进 `AgentLoop` |

## 一致性门禁

新增/修改 Action 或 Context 时，必须同步更新：`APP.md` 第 4 节、
`mcp-server/src/app-adapter.ts`、冒烟测试。`aih tools` / `aih describe` 输出必须与
`APP.md` 第 4 节一致。

```sh
npm run check   # 构建 + 契约一致性校验（含 APP.md ↔ 代码对齐）
npm test        # 冒烟测试
```

## 下一步

- 了解权限模型 → [权限](permissions)
- 了解工具体系 → [工具](tools)
- 会话与审计 → [会话](sessions)
