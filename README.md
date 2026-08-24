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

裁判 prompt 内嵌**完成诚实规则**（借鉴 LongHorizon-Harness 的 Final-State Guard 与
Task Contract，arXiv 2608.01964）：agent 自述"已完成"不算证据，必须从对话中的真实
状态载体（工具读回的文件内容、命令退出码、测试输出）判定；支持扩展裁决
`{"met": bool, "reason": str, "unmet": [...]}`——未满足的验收标准会注入续跑指令，
要求逐项对照持久化状态重新验证。系统提示同样附带该守卫；`/goal` 设置时会回显
结构化契约模板（Objective / Acceptance criteria / Constraints / Current state /
Next move）。

**契约式写法示例**——把模糊目标写成"可验证的目标状态"，三要素：
什么算完成（状态载体）、怎么验证（可执行检查）、什么不能动（约束）：

```
/goal 目标：修复 cli/src/gate.ts 中 deny 规则不生效的问题
验收标准：
1. npm test 全绿（读回退出码）
2. node -e "new Gate().request('write_file')" 返回 denied
约束：不要改动 core/src/ 下任何文件；保持现有导出签名不变
```

一行简写也可以：`/goal README.md 中出现 "v0.2.0 发布说明" 一节；cat README.md 可见；
其他章节不变`。验证方式尽量写成能出真实证据的命令（`npm test`、`grep … file`），
而不是"看起来对"。不设置 `/goal` 时行为与之前一致，仅系统提示多约 550 tokens 的
守卫规则；Goal 裁判零开销（未设置时直接跳过）。

CLI 侧同样可用：`aih run --goal "<条件>" "<任务>"` 在非交互场景做有界自动续跑，
裁判事件以结构化 `goal/judge` 类型写入会话日志（append-only JSONL，可审计回放）。

### 确定性 Workflow（`.aih/workflows/*.mjs`）

把固定流程写成代码而非 prompt——借鉴 MiMo-Code 的 `.mimocode/workflows` 与
opencode 的确定性管线。工作流是导出 `phases` 数组的 ESM 模块：

```js
// .aih/workflows/example.mjs
export default {
  name: "example",
  phases: [
    { name: "check", prompt: "运行 npm test 并总结结果", expect: "passed" }, // 单次 agent 调用
    { name: "fanout", prompts: ["审查 core/", "审查 cli/"] },               // 并行扇出
  ],
};
```

每个 phase 按序执行；`expect` 是输出子串门禁（不满足即 fail-fast），`retries`
限制额外重试次数。跑完输出 JSON 报告：

```sh
aih workflow list                      # 列出 .aih/workflows/ 下所有工作流
aih workflow run example               # 非交互跑完出报告
aih workflow run example --format json # JSON 报告（CI 友好）
```

首发场景：`aih init` 生成的应用 APP.md 验收项一键回归。

### 写后自动格式化

`write_file` / `edit` / `apply_patch` 成功后自动检测项目 formatter 并执行
（借鉴 opencode formatters）：从写入文件向上层目录探测配置文件与 lockfile，
优先级 prettier > biome > eslint `--fix`；带超时（`AIH_FORMAT_TIMEOUT_MS`，
默认 15s）。格式化失败**绝不阻断写入**——只在工具结果附 `formatNote` 提示，
成功则并入 `formatted: true` 标志。

### 并行只读工具调用

单步内**连续的只读工具调用并发执行**（codex `parallel.rs` 同源设计）：读类
批量并发、上限 `AIH_TOOL_CONCURRENCY`（默认 4）；写类保持串行——顺序语义与
doom-loop 判定不受影响。完成顺序不影响落盘：`tool/result` 事件始终按**原始
调用顺序**写入会话日志，回放审计所见即模型所依。

### 变更可视化（diff 渲染）

编辑类工具（`write_file` / `edit` / `apply_patch`）执行后在 TUI 内渲染前后对比
diff：绿 `+` 新增 / 红 `-` 删除，LCS 行级对齐，超 80 行自动截断并提示
`… N more line(s)`。实现位于 `cli/src/diff.ts`（也随 MCP 工具结果返回 `_diff`
字段，可被任意客户端渲染）。

宽终端（≥100 列）为 side-by-side 双列：左删（红底，旧文件行号）/ 右加（绿底，
新文件行号），行号槽按实际最大行号自适应；窄终端（<100 列）自动回退 unified
单列（行号内联）；明/暗双主题色板。TUI 构造项 `width` 可锁定列宽（测试/嵌入）。

### 检查点与回滚（checkpoint / restore）

结构化"可回滚快照点"（roadmap F#28，升级 P0#1 剩余增量）：

- `checkpoint` 事件是**追加式标记**（`SessionLog.checkpoint(note?, contextTokens?)`），
  不重写任何历史；`restoreTo(seq)` 派生"到该标记为止"的前缀，`adopt()` 原地切换指针
- CLI：`aih session checkpoint [name] [note...]` 记录标记；
  `aih session restore <name> [seq]` 把前缀分叉为 `<name>-restore-<seq>` 新会话——
  **原会话文件不动**，append-only 全量历史仍可审计
- TUI：`/checkpoint [note]` 与 `/restore [seq]`；回滚前自动把完整历史快照到
  `*-pre-restore-<时间戳>.jsonl`，被丢弃的后缀随时可查
- **worktree 摘要**：checkpoint 事件附带当时的 git 工作区快照（`WorktreeSummary`：
  分支、HEAD 短 sha、变更文件清单封顶 50 条 + 总数）——恢复点同时告诉你"代码当时
  什么样"；git 缺失/非仓库/超时（5s）时静默省略，绝不阻断 checkpoint；CLI 与 TUI
  记录时打印摘要，restore 时回显该快照
- 冒烟测试覆盖：标记追加、前缀派生、指针切换后 seq 续接、`deriveMessages` 跳过标记、
  拒绝覆盖、坏 seq / 无标记报错；worktree 快照（非仓库 undefined、分支/sha/脏文件、
  封顶计数、事件携带结构化摘要）

### 成本与吞吐（cost / TPS）

会话级成本与吞吐统计（roadmap F#30，对齐 MiMo context sidebar）：

- **价目表**：`cli/src/cost.ts` 内置常见模型 $/1M 价格（OpenAI / Anthropic / Google /
  DeepSeek / Qwen / Meta）；`aih.json` 的 `prices` 键可覆盖（`{ "gpt-4o": { "input": 2.5, "output": 10 } }`），
  匹配为归一化子串——dated id（`gpt-4o-2024-11-20`）命中 `gpt-4o` 行
- **三处展示**：TUI Context 面板加 `cost $x.xx · N tok/s` 行；`/usage` 输出累计成本 + 吞吐；
  `aih stats`（非交互）输出成本 + 吞吐
- **TPS** 为会话平均吞吐（总 token / 时间跨度），数据可推导、可单测；
  逐请求流式 TPS 为剩余增量
- 无价目表匹配时成本显示 `—` 并提示配置 `prices`；mock 模式无 usage 数据，成本/TPS 不显示
- 冒烟测试覆盖：价格解析（精确/子串/大小写/用户覆盖/未命中）、成本计算、TPS 边界、格式化

### Persistent Memory（持久记忆）

`.aih/memory.md` 是 agent 自己维护的持久知识（与 APP.md"人写契约"分离）：

- `remember` 工具写入：`action=append` 追加带日期条目 / `action=set` 整体重写
- 每轮自动注入 system prompt（预算 `AIH_MEMORY_BUDGET`，默认 4000 字符，超出截断）
- TUI `/memory` 查看当前记忆

### Intelligent Context Management（智能上下文管理）

用量提示按最近一次请求的 prompt tokens（真实窗口占用）计算：≥80% 黄色、≥95% 红色。
超限处置对齐 opencode / MiMo-Code 的压缩设计（`session/compaction.ts`）：

- **保留近期尾部原文**：按 `clamp(usable×0.25, 500, 15000)` tokens 保留最近对话**不摘要**，
  切分点落在 user 消息（轮次）边界上，保证 tool 调用/结果不被拆散；只有更旧的头部才进摘要
- **user-query 不变量**（对齐 opencode/MiMo-Code replay）：压缩后模型可见会话**必须含 user 消息**
  ——尾部预算装不下时把本 turn 的 user 原文 replay 成新尾部；历史里没有任何 user 时用合成
  "Continue…" 兜底。否则 Qwen3 一类严格 chat 模板直接 400（`No user query found in messages`）
- **滚动摘要**：每次新摘要折叠进上一次摘要（`<prior-summary>`），用结构化模板
  （目标/约束/决策/当前状态/下一步）产出，工具输出序列化时截断到 2000 字符
- **主动**：每步后 `promptTokens ≥ AIH_COMPACT_AT`(0.8) `× 上下文窗口`(默认 128k)
  → 摘要旧头部，写入 `compaction` 事件（`summary` + `recent` + `trigger`）；之后用"摘要 + 近期尾部"替代全量前史
- **被动**：provider 返回上下文超限错误时自动压缩并重试该步
- **手动**：输入框 `/compact [focus]` 随时压缩（focus 可定向摘要，如"保留所有文件路径"）；
  无旧头部时仍压缩整段对话（刷新滚动摘要）；回显压缩前后 token 数与降幅，
  会话 JSONL 保持 append-only（摘要只是视图，历史可审计）

**窗口按模型设置 + 自动检测**（优先级：`--context-window` > `AIH_CONTEXT_WINDOW` >
**实时探测**（llama.cpp `/slots`，取各 slot `n_ctx` 最小值=单请求有效窗口）> `aih.json` 的
`providers.<name>.contextWindow` / `contextWindow` > 默认 128k）。llama.cpp 服务端把总窗口
按并行槽数（`parallel`）分好后，就在 `/slots` 里以每 slot 的 `n_ctx` 上报，因此"2 并行 256k"
自动解析为 128k，无需手算；非 llama.cpp 端点或探测失败时静默回落到配置值：

```jsonc
// aih.json — 配置值作为探测失败时的回退（可选）
{ "defaultProvider": "qwen",
  "providers": {
    "qwen":     { "model": "qwen3-27b",  "contextWindow": 131072 },
    "deepseek": { "model": "deepseek",   "contextWindow": 65536  }
  } }
```

```sh
AIH_CONTEXT_WINDOW=65536 AIH_COMPACT_AT=0.7 npm run cli -- chat   # 临时覆盖：小窗口模型/更早触发
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
npm run cli -- session checkpoint work "before risky refactor"   # 记录检查点（F#28）
npm run cli -- session restore work   # 回滚：前缀分叉为 work-restore-<seq>（原文件不动）
# TUI 内：/checkpoint [note] 与 /restore [seq]（回滚前自动快照完整历史）
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
- 斜杠命令：`/mode` `/goal` `/tools` `/model <id>`（热切换）`/usage` `/compact [focus]` `/clear`
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

### 安全与调试

- **Shell 环境策略**（借鉴 Codex CLI 的 `shell_environment_policy`）：`run_cmd`
  拉起的子进程**不再继承宿主完整环境**——名字带 `KEY / TOKEN / SECRET / PASSWORD /
  CREDENTIAL` 等敏感词的变量、以及 `AIH_*API*` 凭据一律剔除，`PATH / HOME / TERM`
  等良性变量保留。这样 agent 执行的命令拿不到你的 API key / 数据库密码，避免
  密钥随子进程泄漏或被 `env` 打印。实现见 `cli/src/env-policy.ts`（`buildChildEnv`）。
- **`--debug-prompt`**：每次 LLM 调用前，把**模型实际看到的完整 messages**
  （system prompt + 历史 + 本轮输入）打印到 stderr，用于排查 prompt 组装、
  技能注入、记忆块、goal 守卫是否按预期进入上下文。对应 Codex 的
  `codex debug prompt-input`；内核侧由 `AgentLoop.onPromptInput` 钩子提供
  （`core/src/agent-loop.ts`）。
- **技能名册上下文预算**：系统提示里的 `## Skills` 名册受上下文预算约束
  （窗口已知时取 2%，未知时上限 8000 字符）。超限时先截短各技能描述、
  仍超则省略尾部技能并附提示，避免技能越多越挤占正文上下文。

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
      "models": ["deepseek-v4-flash-free", "hy3-free"],
      "apiKeyEnv": "ZEN_KEY"
    }
  }
}
```

`aih config` 打印生效配置及各字段来源；`aih models` 列出所有 provider。

**一个 provider 挂多个模型**：`model` 是主模型，`models[]` 列出同一端点下额外
可切换的模型（共享该 provider 的 `baseUrl` / `headers` / `apiKeyEnv`）。每个模型
在 `aih models` 与 TUI 的 `ctrl-p` 模型选择器里各占一行，用
`/model <provider>/<model>` 或直接点选即可热切换——适合把免费档 / 多档模型
都挂在一个端点下随时切。

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
| `AIH_CONTEXT_WINDOW` (默认 131072) / `AIH_COMPACT_AT` (0.8) | 上下文窗口与压缩阈值（窗口优先级：`--context-window` > env > llama.cpp `/slots` 实时探测 > aih.json `providers.<name>.contextWindow` / `contextWindow`） |
| `AIH_GOAL_ROUNDS` (3) | `/goal` 与 `run --goal` 的额外续跑轮数上限 |
| `AIH_MEMORY_BUDGET` (4000) | 每轮注入 memory.md 的字符预算 |
| `AIH_CMD_TIMEOUT_MS` (120000) | run_cmd 默认超时 |
| `AIH_TOOL_CONCURRENCY` (4) | 单步内连续只读工具调用的并发上限（写类恒串行） |
| `AIH_FORMAT_TIMEOUT_MS` (15000) | 写后自动格式化超时（失败不阻断写入） |

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
| 上下文压缩（主动+被动+手动 /compact） | — | ✅ | ✅ | — | ✅ 三路+手动 |
| 结构化 checkpoint 回滚 | — | ◐ snapshot | ◐ | — | ✅ `/checkpoint`+`/restore`（F#28，append-only） |
| 项目记忆（memory.md + 注入预算） | — | — | ✅ | — | ✅ |
| Goal 裁判自动续跑 | ✅ goals | — | ✅ | — | ✅ |
| 子代理 / 多 agent | ✅ teams | ✅ subagent | ✅ | — | ◐ 串行 task |
| 并行工具调用（读类 ≤N 有界并发） | ✅ ≤10 | ◐ | ◐ | — | ✅ F#29（写类恒串行） |
| 技能层（SKILL.md 三级加载） | — | ✅ | ✅ | — | ✅ |
| plan/build 双模式 | — | ✅ | ✅ | — | ✅ |
| TUI：流式/markdown/侧栏面板/鼠标 | ◐ Web | ✅ | ✅ | — | ✅ |
| 成本 / TPS 实时显示 | — | ◐ | ✅ | — | ✅ 面板 + /usage + stats（F#30，会话平均 TPS） |
| 确定性 Workflow（阶段脚本） | — | — | ✅ | — | ✅ `.aih/workflows/*.mjs` |
| 写后自动格式化（formatter 集成） | — | ✅ | — | ◐ pre-commit | ✅ prettier>biome>eslint |
| 会话标题/审计留痕/工具钩子 | ✅ | ✅ | ✅ | ✅ decisions | ✅ |
| 跨 agent 指令契约（AGENTS.md） | — | ◐ | ◐ | ✅ | ✅ |
| curl\|bash 一键安装 | — | ◐ | ✅ | — | ✅ |
| CI 门禁 / 仓库卫生包（CHANGELOG、devcontainer） | ✅ | ◐ | ✅ | ✅ | ✅ ci.yml + CHANGELOG.md + .devcontainer |
| serve/attach 多前端 | ✅ Web | ✅ | ✅ | — | ◐ roadmap P2#8 |

**相关性 / 借鉴关系**（均已实读代码，吸收映射见 `docs/review-three-harnesses.md`、`docs/comparison-dsh.md`）：

- **deepseek-harness**（agent 运行时平台）→ 借 `Session Log` 回放不变量、`sessions.fork`、`pre/post-execute` 钩子、goals/续跑方向、并行只读工具（≤N 有界并发，✅ F#29）—— 余：沙箱 seam、后台 jobs（roadmap D/F）。
- **opencode**（终端 coding agent）→ 借 `build/plan`、**内置通用工具集**（→ AIH `--dev`/general-tools）、pattern+路径权限、`doom_loop`、隐藏系统 agent（compaction/title 已落地）；TUI 交互（忙碌排队/markdown/Tab 补全/滚轮）已对齐；写后 formatter（prettier>biome>eslint，✅ F#27）。余：checkpoint 回滚。
- **MiMo-Code**（opencode fork，交互增强）→ 借 `/goal` 裁判续跑 ✅、MEMORY.md 记忆 ✅、侧栏 Context/Todo 面板 ✅、技能层 ✅、curl|bash 安装器 ✅、用量显示 ✅、确定性 workflow（`.aih/workflows/*.mjs` + `aih workflow run`，✅ F#33）。余：成本/TPS ✅ F#30；side-by-side diff ✅ F#31（双色单元格 + 行号列 + 窄屏回退）。
- **LongHorizon-Harness**（AMAP-ML，长时程 Loop Engineering）→ 借 Final-State Guard（完成诚实规则）+ Task Contract 纪律 + 结构化 goal 契约/扩展裁决（`unmet` 回流续跑指令），以单模型守卫形式落地于系统提示与 `/goal` 裁判 ✅（`core/src/prompts.ts`）；余：MEA 三角色循环（Manager/Executor/Auditor + verified-state ledger，候选 roadmap）。
- **Harness-for-codex**（项目级脚手架）→ 借 `AGENTS.md` 单一事实源 + `CLAUDE.md` 桥接 ✅、`harness.yml` 规范 schema ✅、`docs/decisions.md` 留痕 ✅、`verification` 两级门禁（`scripts/eval`）✅；**CI 工作流 = 把 handoff 门禁自动化**（`.github/workflows/ci.yml`，push/PR 跑 check+test）✅。
- **openai/codex**（Codex CLI，Rust）→ 借 `shell_environment_policy`（子进程 env 密钥过滤，✅ `cli/src/env-policy.ts`）、`codex debug prompt-input`（✅ `--debug-prompt` / `AgentLoop.onPromptInput`）、技能名册 2% 上下文预算（✅ `withSkillRoster`）；候选 roadmap：声明式 hooks（`hooks.json` + hash trust）、memories 目录、并行 subagents。

**差距行动清单**（按性价比，详见 `docs/roadmap.md` F 节）：① CI 门禁工作流（HfC）✅；② 写后自动格式化（opencode）✅；③ 结构化 checkpoint 回滚（opencode/P0#1）✅ `/checkpoint`+`/restore` + worktree 摘要；④ 并行只读工具（dsh ≤10）✅；⑤ 成本/TPS 面板（MiMo）✅ 面板 + /usage + stats（余流式 TPS）；⑥ side-by-side diff（MiMo，此前已承诺）✅ 双色单元格 + 行号列 + 窄屏回退 unified；⑦ 仓库卫生包：CHANGELOG/devcontainer（HfC）✅；⑧ 确定性 workflow（MiMo，P1#6 升期）✅。

一句话总结：**写代码用 opencode / MiMo-Code（AIH `--dev` 也提供同类的编码工具集），搭通用 agent 系统用 deepseek-harness，给仓库配协作规约用 Harness-for-codex，把现有业务应用变成 AI 可操作的用 AIH。** AIH 本身作为 MCP server，可以挂进 opencode / codex / claude code 一起用，而不是替代它们；反过来 AIH `--dev` 又可当作一个独立的 coding agent 使用。

## 目录结构

```
aih/
├── APP.md                    # L2：智能体行为契约（唯一事实源）
├── harness.yml               # L2：规范命令 + 任务循环阶段
├── CHANGELOG.md              # L2：发版条目（Keep a Changelog）
├── .devcontainer/            # L2：容器内 agent 稳定环境（create 后自动 bootstrap+build）
├── scripts/{doctor,check,eval}  # L2：标准命令入口
├── tasks/TEMPLATE.md         # L2：任务简报模板
├── docs/decisions.md         # L2：跨会话决策日志
├── core/                     # L1：内核（零运行时依赖）
├── mcp-server/               # L0：MCP 接入（含 TodoApp 示例适配器）
├── cli/                      # CLI 接入：aih run/chat/tools/describe/workflow
├── skills/                   # L3：技能
├── .aih/workflows/           # 确定性工作流（.mjs，导出 phases）
└── examples/opencode.json    # opencode 集成示例
```

## Community & License

MIT。有问题欢迎在 GitHub 提 issue / PR。

---

> **AIH 驱动开发**：本仓库的代码提交由 AIH（App Intelligence Harness）自身完成——
> 从特性开发、联调测试到文档维护，全程由智能体在权限守卫与审计日志的监督下自主执行，
> 正是对"应用接入 AI"这一理念的自我实践。