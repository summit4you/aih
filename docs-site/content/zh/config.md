---
title: 配置
description: aih.json 配置 —— 优先级、provider/模型、多 MCP 服务器、$schema、环境变量。
---

# 配置

## 优先级

**flag > 环境变量 > 项目 `aih.json` / `.aih/config.json` > 全局用户配置**。

配置文件是**合并**而非替换：后面的配置仅在键冲突时覆盖前面的配置，非冲突设置全部保留。

## 全局用户配置（XDG）

全局配置按 **XDG 数据目录规范**解析（`cli/src/paths.ts`）：

```
AIH_HOME  >  $XDG_DATA_HOME/aih  >  ~/.local/share/aih
```

旧版 `~/.aih` 在 XDG 目录不存在时**仍可读**（平滑迁移，已存在的旧配置不丢）。

## 项目配置示例

```json
{
  "$schema": "https://aih.dev/schema/aih.schema.json",
  "defaultProvider": "zen",
  "providers": {
    "zen": {
      "baseUrl": "https://opencode.ai/zen/go/v1/chat/completions",
      "model": "deepseek-v4-flash",
      "models": ["deepseek-v4-flash-free", "hy3-free"],
      "apiKeyEnv": "ZEN_KEY"
    }
  }
}
```

- `model` 是主模型；`models[]` 列出同一端点下额外可切换的模型（共享该 provider
  的 `baseUrl` / `headers` / `apiKeyEnv`）。
- 每个模型在 `aih models` 与 TUI 的 `ctrl-p` 模型选择器里各占一行，用
  `/model <provider>/<model>` 热切换——适合把免费档/多档模型都挂在一个端点下。

## 编辑器补全（`$schema`）

在 `aih.json` / `config.json` 顶部加：

```json
{ "$schema": "https://aih.dev/schema/aih.schema.json" }
```

即获得字段自动补全与校验。`aih config --schema` 直接打印该 JSON Schema
（本地文件 `cli/schema/aih.schema.json`）。

## 多 MCP 服务器（`mcpServers`）

除 `-s/--server` 指定单个 MCP server 外，可声明**多个** MCP 服务器，AIH 并行连接
并聚合全部工具；相同工具名按 `<server>_<tool>` 重命名区隔：

```json
{
  "mcpServers": {
    "todos": {
      "command": "node",
      "args": ["/绝对路径/aih/mcp-server/dist/index.js"],
      "enabled": true
    },
    "search": {
      "command": "npx",
      "args": ["-y", "@some/search-mcp"],
      "name": "web-index"
    }
  }
}
```

- `command` 必填，`args` 可选，`enabled: false` 可临时停用某个服务器。
- 连接优先级：`-s/--server`（单一）> `mcpServers`（多）> 内置 todo-app。
- 多服务器同名工具带服务器前缀（如 `todos_ping` 与 `search_ping`），工具注释标注来源
  `(from <server>)`；单一服务器下工具名保持原样。
- `aih tools` 聚合列出所有已连服务器的工具；`aih config` 打印 `servers` 数组与
  `serverSource`（`flag` / `mcpServers` / `bundled`）。

## 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AIH_MODEL` / `AIH_BASE_URL` / `AIH_API_KEY` | — | 模型、端点、密钥（任意 OpenAI 兼容接口） |
| `AIH_HOME` | — | 全局用户配置/数据目录（最高优先级，覆盖 XDG 默认） |
| `AIH_RETRIES` | `1` | LLM 429/5xx 自动重试次数（鉴权错误不重试） |
| `AIH_FIRST_TOKEN_TIMEOUT_MS` | `180000` | 流式首 token 超时（0 关闭）；带部分内容断流触发**断流续传** |
| `AIH_STALL_TIMEOUT_MS` | `60000` | 流式帧间 stall 超时（0 关闭）；语义同上 |
| `AIH_QUOTA_AUTO_RESUME` | `1` | 配额耗尽时交互会话自动等待重置后**重发被拒调用**（有界 2 次）；`0` 关闭 |
| `AIH_CONTEXT_WINDOW` | `131072` | 上下文窗口 |
| `AIH_COMPACT_AT` | `0.8` | 压缩阈值 |
| `AIH_GOAL_ROUNDS` | `3` | `/goal` 与 `run --goal` 额外续跑轮数上限 |
| `AIH_MEMORY_BUDGET` | `4000` | 每轮注入 memory.md 的字符预算 |
| `AIH_CMD_TIMEOUT_MS` | `120000` | run_cmd 默认超时 |
| `AIH_TOOL_CONCURRENCY` | `4` | 单步内连续只读工具调用的并发上限（写类恒串行） |
| `AIH_FORMAT_TIMEOUT_MS` | `15000` | 写后自动格式化超时（失败不阻断写入） |
| `AIH_TODO_STORE` | — | 示例应用状态持久化路径（跨进程保留） |
| `AIH_BUDGET` | — | PE#2 预算硬边界：JSON 或 `maxCostUsd=1\|maxWrites=5\|timeoutMs=60000\|denyPaths=a\|b`（越界→escalate，退出码 3） |
| `AIH_SENSORS` | — | PE#1 写后传感器：SensorConfig JSON 数组或对象（红→有界重试→升级） |
| `AIH_SENSOR_RETRIES` | `1` | PE#1 传感器红重试次数（之后升级） |
| `AIH_SENSOR_TIMEOUT_MS` | `60000` | PE#1 单传感器命令超时 |
| `AIH_SHELL_CONTEXT` | — | IT#1 `auto` 每轮自动注入最近 shell 上下文 |
| `NO_COLOR` | — | 关闭彩色输出 |

> 完整清单以 `aih config` 输出与 `cli/schema/aih.schema.json` 为准。

## 下一步

- 接入你自己的应用 → [接入你的应用](adapter)
- 了解权限模型 → [权限](permissions)
- 会话管理 → [会话](sessions)
