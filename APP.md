# APP.md — 应用智能体操作契约

> 本文件是 AI 智能体操作本应用的**唯一事实源**，借鉴 Harness-for-codex 的 AGENTS.md 模式。
> 任何接入本应用的智能体（opencode / codex / claude / 自建 copilot）都必须先读本文件。
> 保持本文件与 `harness.yml` 和实际代码一致；不一致时以实际代码为准并立即更新本文件。

## 1. 应用概述

- **应用名称**: `<your-app>`
- **一句话描述**: `<这个应用是做什么的，给谁用>`
- **技术栈**: `<语言 / 框架 / 存储>`

## 2. 领域术语

| 术语 | 含义 |
|---|---|
| `<term>` | `<定义>` |

## 3. 能力边界

### 允许（allow）
- 读取任意业务状态（通过 `app_context`）
- 执行标记为 `permission=allow` 的动作

### 需确认（ask）
- 所有 `kind=write` 且标记为 `ask` 的动作（如删除、发布、支付）
- 批量操作（一次影响 >10 条记录）

### 禁止（deny）
- 直接访问数据库/文件系统绕过应用 API
- 修改用户凭据与权限相关数据
- `<其他业务红线>`

### 信任模型（OC#4 — 本地单算子，非多租户安全边界）
- **信任边界 = 宿主 OS 用户**。AIH 是本地单算子：能操作该 agent 的人（宿主用户）就能让 agent
  做任何 agent 能做的事。session 的所有权/可见性是**可用性特性，不是安全边界**——不要把它
  当作隔离手段。
- **prompt-injection-only 链不算安全 bug**：仅靠「模型被诱导」而**没有**越过下列任一硬边界的
  路径，不在威胁模型内。硬边界 = `allow/ask/deny` 权限门（`ApprovalGate`）、凭据脱敏与
  owner 隔离（`redactCredential` / 降级而非 fallback）、sandbox seam（默认 local，可切
  bwrap/remote）、工具注册表的 `deny` 红线。越过其中任一才算安全事件。
- **需要真隔离时**：用独立 agent / 独立宿主（独立 OS 用户或容器）建立新的信任边界，而不是
  指望 prompt 或 session 隔离。
- **对手模型**：默认对手是「同宿主用户」与「不可信的外部内容（网页/工具输出）」。外部内容
  只能影响模型意图，不能直接触达 deny 红线或凭据——除非它诱导模型主动调用一个被 allow/ask
  放行的工具，而那属于用户对权限配置的决策。

## 4. 接入原语清单（L0）

### Context（可读状态）
| query | 返回内容 |
|---|---|
| `all` | 全量快照 |
| `stats` | 统计摘要 |

### Action（可执行动作）
| 动作 | kind | permission | 说明 |
|---|---|---|---|
| `list_todos` | read | allow | 列出条目 |
| `add_todo` | write | allow | 新增条目 |
| `toggle_todo` | write | ask | 切换状态 |
| `remove_todo` | write | ask | 删除条目 |

### Event（变更事件，可选）
| 事件 | 触发时机 |
|---|---|
| `todo.added` | 新增条目后 |

## 5. 标准命令

| 命令 | 用途 |
|---|---|
| `npm run doctor` | 环境与应用就绪检查 |
| `npm run check` | 构建 + 一致性校验 |
| `npm test` | 冒烟测试（core / mcp / cli） |
| `npm run eval` | 完整交接门禁（doctor + bootstrap + check + test） |
| `npm run cli -- <cmd>` | CLI 接入：`run` / `chat` / `tools` / `describe` / `sessions` |
| `npm run bench` | AIH vs opencode 性能基准 |

### CLI 接入约定

- `aih tools` / `aih describe` 输出必须与 APP.md 第 4 节一致（多 MCP 服务器时
  聚合所有已连接服务器的工具；跨服务器重名工具按 `<server>_<tool>` 重命名）
- 服务器解析优先级：`-s/--server`（单一）> 配置 `mcpServers`（多）> 内置 todo-app；
  `aih config` 打印 `servers` 数组与 `serverSource`（`flag`/`mcpServers`/`bundled`）
- 写操作默认需确认：TTY 下 `[y/N]` 提示，非 TTY 下须显式 `--yes`，否则拒绝执行
- 无 API key 时用 `--mock` 离线演示；真实调用走 OpenAI 兼容接口
  （`AIH_API_KEY` + `AIH_MODEL`，可选 `AIH_BASE_URL`）
- 会话持久化：`--session <name>` 保存、`-c` 续跑最近会话，文件为 append-only JSONL
- Token 用量累加进 `turn/end` 事件；LLM 对 429/5xx 自动重试
- 示例应用状态持久化：设置 `AIH_TODO_STORE=<path>` 后跨进程保留（真实应用自带存储则无需）

## 6. 变更规则

1. 新增/修改 Action 或 Context 时，必须同步更新：本文件第 4 节、`mcp-server/src/app-adapter.ts`、冒烟测试。
2. 破坏性变更需先在 `docs/decisions.md` 记录决策。
3. 完成任务前运行 `npm run eval` 作为交接门禁。
