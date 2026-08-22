<h1 align="center">AIH — App Intelligence Harness</h1>

<p align="center"><strong>让任意普通应用（Web / 桌面 / 移动 / 后端服务）通过标准化接入获得 AI 能力的通用框架。</strong></p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness">deepseek-harness</a> · <a href="https://github.com/anomalyco/opencode">opencode</a> · MIT
</p>

---

AIH（App Intelligence Harness）把"应用接入智能体"这件事标准化：实现一个轻量的
`AppAdapter`（读 Context / 写 Action / 收 Event），你的业务应用就获得了
allow/ask/deny 三级权限、append-only 会话审计、可插拔技能层与三种接入形态
（MCP 外挂 / CLI / 内嵌 SDK）——不需要改动任何业务代码。

---

## Quick Start

```sh
npm run bootstrap   # 安装依赖
npm run doctor      # 就绪检查
npm run check       # 构建 + 契约一致性校验
npm test            # 冒烟测试（core / mcp / cli）
npm run eval        # 完整交接门禁（doctor + bootstrap + check + test）
```

```sh
# 直接运行 aih 进入交互终端（opencode 风格 TUI，需 TTY）
aih

# 一次性问答（--mock 离线演示，无需 API key）
npm run cli -- run "add a todo buy milk" --mock

# 真实模型（任意 OpenAI 兼容接口，支持 SSE 流式输出）
AIH_BASE_URL=https://api.deepseek.com/v1 \
AIH_MODEL=deepseek-chat \
AIH_API_KEY=sk-... npm run cli -- run "今天有哪些待办？"
```

---

## Core Features

AIH 的四层内核把"接入"拆成职责分明的层级，与 deepseek-harness / opencode 的
设计融合点如下：

| 来源 | 借鉴 | 落点 |
|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | append-only Session Log（"模型可见即可回放"）、守卫式工具管线、Agent Loop、可替换能力接缝（Seam） | `core/`（L1 内核） |
| [Harness-for-codex](https://github.com/ganimjeong/Harness-for-codex) | AGENTS.md 式指令契约、标准命令（bootstrap/check/test/eval/doctor）、任务简报与决策日志 | `APP.md`、`harness.yml`、`scripts/`、`tasks/`、`docs/`（L2 规程） |
| open agent skills 生态 | SKILL.md 渐进披露、技能自进化 | `skills/`（L3 技能层） |

### L0 接入层（AppAdapter）

实现一个 `AppAdapter` 即可接入任意应用：`descriptor` + `context(query)` +
`actions`（动作参数用 zod 定义）。三个原语：

| 原语 | 含义 |
|---|---|
| **Context** | 读操作，`allow` 级，直接执行 |
| **Action** | 写操作，带 `allow/ask/deny` 权限 |
| **Event** | 变更事件流，可选 |

### 三种接入形态

| 形态 | 场景 | 入口 |
|---|---|---|
| **MCP 外挂**（零侵入，推荐起步） | 挂进 opencode / codex / claude code 等任何 MCP 客户端 | `mcp-server/dist/index.js` |
| **CLI 接入** | 交互终端、一次性问答、脚本管道 | `aih` / `aih run` / `aih chat` |
| **内嵌 Copilot**（SDK） | 直接复用 L1 内核，把工具注册进 `AgentLoop` | `@aih/core` |

### Multiple Agents（build / plan）

对齐 opencode 的 build/plan 分工：

- **build**：默认，全量工具权限用于开发
- **plan**：只读分析模式，全部 `kind=write` 工具从注册表隐藏
  （含 `--dev` 的 write_file/run_cmd），meta 行显示 `plan · …`（黄色）

Tab（无补全时）或 `/mode <build|plan>` 切换。

### Goal / Stop Condition

`/goal <条件>` 后每轮结束由一次独立 LLM 调用裁判条件是否真满足——满足即停
（`✅ goal met`），不满足自动注入续跑指令再战，最多 `AIH_GOAL_ROUNDS`（默认 3）
个额外轮次；`/goal clear` 取消。防"乐观停止"，是批量操作/巡检类任务的关键可靠性开关。

### 变更可视化（diff 渲染）

编辑类工具（`write_file` / `edit` / `apply_patch`）执行后在 TUI 内渲染前后对比
diff：绿 `+` 新增 / 红 `-` 删除，LCS 行级对齐，超 80 行自动截断并提示
`… N more line(s)`。实现位于 `cli/src/diff.ts`（也随 MCP 工具结果返回 `_diff`
字段，可被任意客户端渲染）。

### Persistent Memory（持久记忆）

`.aih/memory.md` 是 agent 自己维护的持久知识（与 APP.md"人写契约"分离）：

- `remember` 工具写入：`action=append` 追加带日期条目 / `action=set` 整体重写
- 每轮自动注入 system prompt（预算 `AIH_MEMORY_BUDGET`，默认 4000 字符，超出截断）
- TUI `/memory` 查看当前记忆

### Intelligent Context Management（智能上下文管理）

用量提示按最近一次请求的 prompt tokens（真实窗口占用）计算：≥80% 黄色、≥95% 红色。
超限处置对齐 opencode compaction / MiMo checkpoint 思路：

- **主动**：每步后 `promptTokens ≥ AIH_COMPACT_AT`(0.8) `× AIH_CONTEXT_WINDOW`(128k)
  → 调一次无工具 LLM 摘要历史，写入 `compaction` 事件；之后用"摘要 + 近期消息"替代全量前史
- **被动**：provider 返回上下文超限错误时自动压缩并重试该步

```sh
AIH_CONTEXT_WINDOW=65536 AIH_COMPACT_AT=0.7 npm run cli -- chat   # 小窗口模型/更早触发
```

### Session Persistence & Audit（会话持久化与审计）

`chat` 与 `run` 默认把会话持久化到 `.aih/sessions/default.jsonl`（退出即落盘，
含 Ctrl-C/exit 中断场景），再次进入自动续上；续跑时自动**回放历史**
（`replayHistory`：用户/助手消息、工具调用与结果、压缩事件按原序渲染，上下文完整还原）；
`--ephemeral` 可关闭持久化。

```sh
npm run cli -- chat                                # 默认持久化到 default，下次自动恢复
npm run cli -- run "添加待办A" --session work     # 指定会话名 → .aih/sessions/work.jsonl
npm run cli -- run "再添加B" -c                   # 续跑最近会话（上下文完整保留）
npm run cli -- session list                       # 列出
npm run cli -- session show work                  # 人类可读回放
npm run cli -- session export work  > work.json   # 导出为 JSON
npm run cli -- session fork default branch-a --from 7   # 从事件序 7 分叉出新会话
npm run cli -- session rm work                    # 删除
npm run cli -- stats                              # 所有会话 token 用量汇总
```

会话文件为 append-only JSONL（每行一个 SessionEvent），可直接审计或程序化回放。
每次工具调用另追加到 `.aih/tool-audit.jsonl`（ts/tool/args[4KB]/ok/error），
含 `task` 子代理内部调用；`--no-audit` 关闭。"模型可见即已记录"不变量。

### Subagent System（子代理）

`task` 工具派发子代理：独立上下文、≤8 步、不可再嵌套，返回最终答案。
`task` 本身免审，但其子代理调用的每个工具仍走各自权限门。

### Builtin Skills（内置技能）

技能是可复用的指令包（YAML frontmatter + 正文），让 agent "接入即懂行"：

```sh
npm run cli -- skills list                        # 列出：project > user > builtin 三级
npm run cli -- skills find tour                   # 按关键词检索（名称命中加权）
npm run cli -- skills install app-tour            # 把内置技能落盘到 .aih/skills/
npm run cli -- skills show app-tour               # 查看正文
```

内置：

| Skill | Description |
|---|---|
| `app-tour` | 探索已接入应用的工具并产出能力巡览 |
| `batch-ops` | 批量数据操作的 plan-execute-verify 模式 |
| `session-report` | 把当前会话历史整理成结构化报告 |

同名时项目覆盖用户覆盖内置；会话与 `run` 中技能清单注入 system prompt，模型按需
调用 `load_skill` 加载全文；TUI `/skills` 列出、`/<技能名>` 直接注入。

### 权限模型（allow / ask / deny）

| 档位 | 默认对象 | 行为 |
|---|---|---|
| `allow` | 读操作 | 直接执行 |
| `ask` | 写操作 | 经 `ApprovalGate` 人工/策略确认 |
| `deny` | 业务红线 | 注册表直接拒绝 |

策略实现 `ApprovalGate` 即可接入自有审批系统（`PolicyGate` 提供规则引擎雏形）。
TUI 内联确认：`⚠ approval requested: <tool> <args>` → `[y] once · [n] no ·
[a] always <scope>`；`scope` 由目标路径自动推导为父目录，选 `a` 按 last-match-wins
持久化到 aih.json（项目 > 全局）。

### TUI（交互终端）

opencode / MiMo-Code 风格全屏 TUI：

- **轻 Markdown 渲染**：标题→粗体、代码块→暗色+**语法高亮**（关键字/字符串/数字/
  注释分色）、引用→暗色、列表→`•`/序号、行内代码→青色、行内链接双色下划线、
  表格 `|`→`·`；工具调用图标行内（`$` bash / `→` read / `✱` search / `%` web /
  `←` write / `#` todo / `⚙` 其他）；同类工具自动分组折叠（`$ bash ×3 click to
  expand`）；`run_cmd` 等结果前三行预览（`… N more · click to expand`）
- **权限确认（文件夹级记忆）**：忙碌中提交自动排队（`queued: …`）
- **多行输入框**：按显示宽度折行（CJK 宽字符感知、光标精确定位）、框内滚动；
  `/` 触发 Tab 幽灵补全；忙碌时旋转指示器 + 已用秒数
- **底部**：重边线（滚动时 `↑N`）+ 提示行（cwd · 快捷键 · 右侧上下文用量
  `used/limit (pct%)`）+ 状态行（`⊙ N MCP` 徽章 · 应用 · 版本 · 会话名）
- **交互**：鼠标滚轮 / PgUp/PgDn 滚动；上下键翻输入历史；`exit`（或 `/quit`，
  `ctrl-c` 清空输入再按退出）还原终端；忙碌中 `ctrl-c` 取消当前轮不退出
- 斜杠命令：`/mode` `/goal` `/tools` `/model <id>`（热切换）`/usage` `/clear`
  `/inject <text>` `/events` `/skills` `/ <技能名>`
- 会话标题：首轮后自动 LLM 生成 2–6 词标题（`<name>.jsonl.meta.json`），状态栏与
  `session list` 显示

### 通用/编程能力（本地工具集，对齐 opencode 内置工具）

AIH 的 agent 内核是通用的，工具来自外接应用；交互终端默认再挂一套本地工具
（与任意 MCP 应用工具并存，同名时应用工具优先）：

| 工具 | 说明 | 权限 |
|---|---|---|
| `list_dir` / `read_file` | 列目录 / 读文件（64KB 截断、行偏移） | allow |
| `write_file` / `run_cmd` | 写文件 / 执行命令（默认 120s 超时、可传 timeout_ms 至 600s；后台子进程不阻塞返回） | ask |
| `edit` | 精确字符串替换编辑（歧义时报错，`replace_all` 全量） | ask |
| `glob` | `**/*.ts` 模式找文件（无 `/` 的模式任意深度匹配） | allow |
| `grep` | 正则内容搜索 + `include` 文件名过滤 | allow |
| `todo` | 任务清单（`.aih/todos.json`，至多一个 in_progress） | allow |
| `remember` | 项目记忆：追加/重写 `.aih/memory.md`，跨会话持久化知识 | allow |
| `question` | 模型向用户提问并等待回答（TUI 内联问答行） | allow |
| `webfetch` | 抓取 URL → 纯文本（HTML 转 text，64KB 截断） | allow |
| `websearch` | DuckDuckGo 搜索（标题/URL/摘要，免 key） | allow |
| `task` | 派发子代理（独立上下文、≤8 步、不可再嵌套） | allow* |
| `apply_patch` | 多文件补丁（Add/Update/Delete/Move，opencode 格式） | ask |

plan 模式下所有 `ask` 写工具自动隐藏。未对齐 opencode 的仅 `lsp`（语言服务器基建）
与实验性 `execute`(code-mode)——前者属 MCP 外挂范畴，后者由 run_cmd + roadmap 沙箱 seam 覆盖。

---

## Architecture

```
L3 技能层   skills/aih-app-integration   按需加载的领域知识，可由 skill-creator 自进化
L2 规程层   APP.md · harness.yml · scripts · tasks · docs/decisions.md
L1 内核层   core/  SessionLog · ToolRegistry(守卫管线) · AgentLoop(turn/step) · Seams(LLM/权限)
L0 接入层   mcp-server/  AppAdapter: Context(读) / Action(写,带权限) / Event(流)
横切面      权限三档 allow/ask/deny · 审计日志 · eval 交接门禁
```

## Configuration

优先级：**flag > 环境变量 > 项目 `aih.json`/`.aih/config.json` > 全局 `~/.aih/config.json`**。

```json
{
  "defaultProvider": "zen",
  "providers": {
    "zen": {
      "baseUrl": "https://opencode.ai/zen/go/v1/chat/completions",
      "model": "deepseek-v4-flash",
      "apiKeyEnv": "ZEN_KEY"
    }
  }
}
```

`aih config` 打印生效配置及各字段来源；`aih models` 列出所有 provider。

### 多 MCP 服务器（`mcpServers`）

除 `-s/--server` 指定单个 MCP server 外，配置里可以声明**多个** MCP 服务器，
AIH 会并行连接并聚合全部工具；相同工具名按 `<server>_<tool>` 重命名区隔：

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
- 来自多个服务器的同名工具会带上服务器前缀（如两个服务器都导出 `ping`，
  则出现 `todos_ping` 与 `search_ping`），工具的注释里标注来源
  （`(from <server>)`）；单一服务器下的工具名保持原样。
- `aih tools` 聚合列出所有已连服务器的工具；`aih config` 打印 `servers` 数组
  与 `serverSource`（`flag` / `mcpServers` / `bundled`）标明当前来源。

### 环境变量

| 变量 | 作用 |
|---|---|
| `AIH_MODEL` / `AIH_BASE_URL` / `AIH_API_KEY` | 模型、端点、密钥（任意 OpenAI 兼容接口） |
| `AIH_RETRIES` (1) | LLM 429/5xx 自动重试次数（鉴权错误不重试） |
| `NO_COLOR` | 关闭彩色输出 |
| `AIH_CONTEXT_WINDOW` (131072) / `AIH_COMPACT_AT` (0.8) | 上下文窗口与压缩阈值 |
| `AIH_GOAL_ROUNDS` (3) | `/goal` 额外续跑轮数上限 |
| `AIH_MEMORY_BUDGET` (4000) | 每轮注入 memory.md 的字符预算 |
| `AIH_CMD_TIMEOUT_MS` (120000) | run_cmd 默认超时 |

### 会话标题（隐藏系统 agent）

首轮结束后自动用一次轻量 LLM 调用生成 2–6 词标题：写入 `<name>.jsonl.meta.json`，
TUI 状态栏 `S:` 位与 `session list` 标题列实时显示；已有标题则直接复用。

### 脚手架与独立服务

```sh
npm run cli -- init my-app            # 生成 APP.md/AGENTS.md/CLAUDE.md/harness.yml/scripts/mcp-server 全套骨架
npm run cli -- mcp                    # 以独立进程运行内置 todo-app MCP server
```

### Token 用量统计

每次 LLM 响应的 usage 被累加进 `turn/end` 事件并随会话持久化：

```sh
npm run cli -- run "..."          # 文本模式页脚: [turn xxx, 2 step(s), end_turn, tokens 512/89/601]
npm run cli -- run "..." -f json  # JSON 模式: turn/end 事件含 usage 字段
```

### 性能基准

```sh
AIH_API_KEY=sk-... npm run bench   # 对比 opencode（需本地安装且 cwd 有 opencode.json）
```

实测（deepseek-v4-flash @ OpenCode Go，各 3 轮均值）：单轮对话 AIH ~2.4s vs
opencode ~7.4s；工具任务 ~5.9s vs ~11.2s；正确率双方均 14/14。详见 `.aih/bench.tsv`。

---

## Development

```sh
npm run build       # tsc -b 构建三个 workspace
npm test            # 冒烟测试：node core/dist/smoke.js && mcp-server && cli
npm run eval        # 完整交接门禁（doctor + bootstrap + check + test）
```

## 把智能体接到你的应用

### 方式一：MCP 外挂（零侵入，推荐起步）

构建后把 `mcp-server/dist/index.js` 注册为 MCP server。以 opencode 为例，
参见 `examples/opencode.json`：

```json
{
  "mcp": {
    "aih": { "type": "local", "command": ["node", "/绝对路径/aih/mcp-server/dist/index.js"] }
  }
}
```

之后任何 opencode 会话即可调用 `app_describe` / `app_context` / `add_todo` 等
工具操作应用。codex、claude code 等支持 MCP 的智能体同理。

### 方式二：CLI 接入（参考 opencode 的 run/chat 风格）

`run` 支持管道输入（与 opencode 一致）：`echo "补充说明" | aih run "处理这个"`。
文本模式默认流式输出（逐 token 渲染，`--no-stream` 可关闭）；工具调用以
`⚙ name {args}` 内联显示在 stderr，stdout 保持干净可重定向。
写操作默认需确认：TTY 下 `[y/N]` 提示；非 TTY 必须显式 `--yes`。
彩色输出自动关闭（非 TTY 或设置 `NO_COLOR`）。

### 方式三：内嵌 Copilot（SDK 模式）

直接复用 L1 内核：

```ts
import { AgentLoop, SessionLog, ToolRegistry, AutoApprove } from "@aih/core";

const tools = new ToolRegistry(new AutoApprove());
tools.register(myAppTool);          // 你的应用动作
const loop = new AgentLoop({ llm: myLLMAdapter, tools, systemPrompt: "..." });
await loop.send("帮我把上周的订单导出");
```

`llm` 只需实现 `LLMAdapter` 接口（OpenAI 兼容 / DeepSeek / 本地模型均可）。

## 接入你自己的应用

1. 在 `mcp-server/src/app-adapter.ts` 旁新建你的 Adapter（实现 `AppAdapter`：
   `descriptor` + `context(query)` + `actions`，动作参数用 zod 定义）。
2. 在 `mcp-server/src/index.ts` 中替换 `TodoAppAdapter`。
3. 同步更新 `APP.md` 第 4 节（原语清单）。
4. 扩展 `mcp-server/src/smoke.ts` 覆盖新适配器的一读一写。
5. 运行 `npm run eval` 通过交接门禁。

详细规程见技能文件 `skills/aih-app-integration/SKILL.md`
（可用 `npx skills add <本仓库>` 安装给任何智能体）。

## 与 deepseek-harness / opencode / MiMo-Code / Harness-for-codex 的对比

AIH 与四个主流开源项目定位不同、各有侧重。下表从使用者的角度对比功能与相关性：

| 维度 | [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | [opencode](https://github.com/anomalyco/opencode) | [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) | [Harness-for-codex](https://github.com/ganimjeong/Harness-for-codex) | AIH（本仓库） |
|---|---|---|---|---|---|
| 定位 | Agent 运行时框架（"一切皆插件"） | 通用 AI coding agent（终端原生） | opencode 的企业级 fork（交互/安全性增强） | 项目级 AI 协作脚手架（模板仓） | 应用智能体 Harness（App Intelligence） |
| 服务对象 | 开发者搭建自己的 agent 系统 | 开发者写代码 | 需要企业级护栏的 coding 团队 | 想给单个仓库配 AI 协作规约的团队 | 把**任意业务应用**（Web/桌面/后端）接入 AI |
| 核心抽象 | 插件（plugin，基于 Cordis） | build/plan 双 agent + 内置工具集 + MCP | 在 opencode 之上加 agent 护栏/交互优化 | AGENTS.md + harness.yml + scripts/tasks/docs | L0 AppAdapter（Context/Action/Event）+ 四层内核（L1 内核/L2 规程/L3 技能）+ 内置通用工具集 |
| 运行形态 | Web UI（`npx @deepseek-ai/dsh web`，默认 127.0.0.1:3080） | TUI / CLI / 桌面 App | TUI / CLI（fork 自 opencode） | 仓库模板（配合 codex/claude 使用） | TUI / CLI / SDK，另提供 MCP server 外挂应用 |
| 与 MCP 的关系 | 插件生态（含 MCP 能力） | 作为 MCP client 消费外部工具 | 同 opencode（MCP client） | 无（面向 codex 的 AGENTS.md 规约） | 自身即 MCP server，可被 opencode / codex / claude code 等消费 |
| 权限模型 | 插件级权限声明 | 按 agent（build/plan）分档 + 规则审批（含 doom_loop 行为级守卫） | 同 opencode（fork 继承），面向企业加固 | `verification.default/handoff` 门禁 | 工具级 allow/ask/deny 三档 + ApprovalGate 可插拔审批 |
| 接入业务应用 | 写插件 | 写 MCP server / 工具 | 写 MCP server / 工具 | 写 AGENTS.md / harness.yml | 内置通用编码工具集（`--dev`：read/write/edit/glob/grep/run_cmd/apply_patch/搜索/子代理）+ 实现 AppAdapter 接入业务应用 |
| 会话与审计 | Session Log（模型可见即可回放） | 会话持久化 + LSP 上下文 | 同 opencode + 企业审计 | 决策日志 docs/decisions.md | append-only JSONL SessionEvent + 工具审计 |
| 协议 | MIT | MIT | MIT（opencode 的 fork） | MIT | MIT |

**功能矩阵**（2026-08-22 四仓交叉核对，✅ 完整 / ◐ 部分或规划 / — 无）：

| 能力 | dsh | opencode | MiMo | HfC | **AIH** |
|---|---|---|---|---|---|
| MCP 双向（server+client） | ◐ 插件内含 | ◐ client | ◐ client | — | ✅ **server+client** |
| 任意应用零代码接入（AppAdapter） | — | — | — | — | ✅ **独有** |
| append-only 会话回放/分叉 | ✅ | ✅ | ✅ | — | ✅ |
| 权限规则集（pattern/路径作用域/last-match） | ◐ 沙箱视角 | ✅ | ✅ | — | ✅ |
| doom_loop 死循环守卫 | ◐ 钩子拦截 | ✅ | ✅ | — | ✅ |
| 上下文压缩（主动+被动+有界摘要） | — | ✅ | ✅ | — | ✅ 三路 |
| 结构化 checkpoint 回滚 | — | ◐ snapshot | ◐ | — | ◐ roadmap F#3 |
| 项目记忆（memory.md + 注入预算） | — | — | ✅ | — | ✅ |
| Goal 裁判自动续跑 | ✅ goals | — | ✅ | — | ✅ |
| 子代理 / 多 agent | ✅ teams | ✅ subagent | ✅ | — | ◐ 串行 task |
| 并行工具/子 agent（≤N） | ✅ ≤10 | ◐ | ◐ | — | ◐ roadmap F#4 |
| 技能层（SKILL.md 三级加载） | — | ✅ | ✅ | — | ✅ |
| plan/build 双模式 | — | ✅ | ✅ | — | ✅ |
| TUI：流式/markdown/侧栏面板/鼠标 | ◐ Web | ✅ | ✅ | — | ✅ |
| 成本 / TPS 实时显示 | — | ◐ | ✅ | — | ◐ 仅 token，F#5 |
| 确定性 Workflow（阶段脚本） | — | — | ✅ | — | ◐ roadmap P1#6 |
| 写后自动格式化（formatter 集成） | — | ✅ | — | ◐ pre-commit | ◐ roadmap F#2 |
| 会话标题/审计留痕/工具钩子 | ✅ | ✅ | ✅ | ✅ decisions | ✅ |
| 跨 agent 指令契约（AGENTS.md） | — | ◐ | ◐ | ✅ | ✅ |
| curl\|bash 一键安装 | — | ◐ | ✅ | — | ✅ |
| CI 门禁 / 仓库卫生包（CHANGELOG、devcontainer） | ✅ | ◐ | ✅ | ✅ | ◐ F#1/F#7 |
| serve/attach 多前端 | ✅ Web | ✅ | ✅ | — | ◐ roadmap P2#8 |

**相关性 / 借鉴关系**（均已实读代码，吸收映射见 `docs/review-three-harnesses.md`、`docs/comparison-dsh.md`）：

- **deepseek-harness**（agent 运行时平台）→ 借 `Session Log` 回放不变量、`sessions.fork`、`pre/post-execute` 钩子、goals/续跑方向 —— **全部已落地**；余：并行工具、沙箱 seam、后台 jobs（roadmap D/F）。
- **opencode**（终端 coding agent）→ 借 `build/plan`、**内置通用工具集**（→ AIH `--dev`/general-tools）、pattern+路径权限、`doom_loop`、隐藏系统 agent（compaction/title 已落地）；TUI 交互（忙碌排队/markdown/Tab 补全/滚轮）已对齐。余：写后 formatter、checkpoint、并行（roadmap F）。
- **MiMo-Code**（opencode fork，交互增强）→ 借 `/goal` 裁判续跑 ✅、MEMORY.md 记忆 ✅、侧栏 Context/Todo 面板 ✅、技能层 ✅、curl|bash 安装器 ✅、用量显示 ✅。余：成本/TPS、侧边 diff、workflow（roadmap F）。
- **Harness-for-codex**（项目级脚手架）→ 借 `AGENTS.md` 单一事实源 + `CLAUDE.md` 桥接 ✅、`harness.yml` 规范 schema ✅、`docs/decisions.md` 留痕 ✅、`verification` 两级门禁（`scripts/eval`）✅；**CI 工作流 = 把 handoff 门禁自动化**（roadmap F#1，已随本批次落地）。

**差距行动清单**（按性价比，详见 `docs/roadmap.md` F 节）：① CI 门禁工作流（HfC）→ 已随本批次落地；② 写后自动格式化（opencode）；③ 结构化 checkpoint 回滚（opencode/P0#1）；④ 并行只读工具（dsh ≤10）；⑤ 成本/TPS 面板（MiMo）；⑥ side-by-side diff（MiMo，此前已承诺）；⑦ 仓库卫生包：CHANGELOG/devcontainer（HfC）；⑧ 确定性 workflow（MiMo，P1#6 升期）。

一句话总结：**写代码用 opencode / MiMo-Code（AIH `--dev` 也提供同类的编码工具集），搭通用 agent 系统用 deepseek-harness，给仓库配协作规约用 Harness-for-codex，把现有业务应用变成 AI 可操作的用 AIH。** AIH 本身作为 MCP server，可以挂进 opencode / codex / claude code 一起用，而不是替代它们；反过来 AIH `--dev` 又可当作一个独立的 coding agent 使用。

## 目录结构

```
aih/
├── APP.md                    # L2：智能体行为契约（唯一事实源）
├── harness.yml               # L2：规范命令 + 任务循环阶段
├── scripts/{doctor,check,eval}  # L2：标准命令入口
├── tasks/TEMPLATE.md         # L2：任务简报模板
├── docs/decisions.md         # L2：跨会话决策日志
├── core/                     # L1：内核（零运行时依赖）
├── mcp-server/               # L0：MCP 接入（含 TodoApp 示例适配器）
├── cli/                      # CLI 接入：aih run/chat/tools/describe
├── skills/                   # L3：技能
└── examples/opencode.json    # opencode 集成示例
```

## Community & License

MIT。有问题欢迎在 GitHub 提 issue / PR。

---

> **AIH 驱动开发**：本仓库的代码提交由 AIH（App Intelligence Harness）自身完成——
> 从特性开发、联调测试到文档维护，全程由智能体在权限守卫与审计日志的监督下自主执行，
> 正是对"应用接入 AI"这一理念的自我实践。