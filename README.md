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

## Installation

**macOS / Linux / WSL** — one-line install (requires [Node.js](https://nodejs.org/) ≥ 20):

```sh
curl -fsSL https://raw.githubusercontent.com/summit4you/aih/main/scripts/install | bash
```

**Windows PowerShell**:

```powershell
irm https://raw.githubusercontent.com/summit4you/aih/main/scripts/install.ps1 | iex
```

**Options**: `--version <ver>` (指定版本)、`--dir <path>` (自定义目录)、`--no-modify-path`

**From source** (开发者):

```sh
git clone https://github.com/summit4you/aih && cd aih
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

### serve / attach（远程模式）

`aih serve` 把 harness（MCP + loop）跑成无头 HTTP/SSE 服务，解决 SSH 卡顿、
让 UI 与后端分离：

```sh
aih serve --port 8787 --session work   # 无头跑 harness（MCP + loop）
aih attach http://127.0.0.1:8787       # 从另一台机器 attach 一个 REPL
```

- `GET /health`：就绪检查（工具数 / 会话名 / 版本）
- `GET /events`：SSE 事件流（含流式 `app/event` 增量帧）
- `POST /message`：提交一轮，返回结构化结果
- `GET /tools`：列出当前工具集
- `aih attach` 是 SSE 客户端：回放既有事件 + 实时续接，可选 `--min-events` /
  `--timeout`；`attachInteractive` 提供 REPL。实现：`cli/src/serve.ts`。

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

### shell 上下文感知（IT#1）

agent 可以**主动取用**本会话最近的 shell 上下文，免去用户手动粘贴报错/输出
（借鉴 Intelligent Terminal "agent has context on your shell output, no
copy-pasting needed"）。纯 seam `cli/src/shell-context.ts`（无 I/O、无 LLM、
可单测）在 session log 的 `run_cmd` `tool/call`+`tool/result` 之上抽取最近 N 条
命令（命令 · 退出码 · cwd · 输出尾部；`keep_output` 时附全量输出文件路径），
只读 `run_cmd` 的 `stdout` 字段、不泄漏其他工具输出；用 `result.code` 判成败
（非零退出仍是 `ok:true`，故读 `code` 而非 `ok`）。三种用法：

- **`shell_context` 工具**（read/allow）：agent 按需取用，`max_commands`（默认 3，
  上限 10）/`max_output_chars`（默认 4000）可调；无 shell 历史 → `{ found:false }`
  明确空态。
- **TUI `/shell`**：展示最近 shell 上下文；`/shell --send` 把上下文块注入下一 turn。
- **`AIH_SHELL_CONTEXT=auto`**：每个正常消息 turn 起始自动附带（空态 → no-op，
  不注入噪声）。

### 确定性 shell 失败检测 + 一键修复（IT#2）

`run_cmd` 失败（非零退出码 / 超时）时，AIH **确定性**（非 LLM）检测并点亮状态栏
错误指示，一键把失败上下文送 agent 求修复（借鉴 Intelligent Terminal "auto-detect
command failures, send to agent for fix suggestions"）。纯 seam
`cli/src/error-detect.ts`（无 I/O、无 LLM、可单测）复用 IT#1 `extractShellContext`：

- **失败判定**：非零退出码或超时（`isFailed`）。**退出码 0 永不误报为失败**——
  分类只是**标注**种类（固定正则集 `crash/network/js/test/fs/build/unknown`），
  不决定成败，故绿色命令不会被误判、失败命令无已知模式时仍报 `unknown`。
- **状态栏指示**：红色 `⚠ N failed`（`tui.ts` `shellErrorBadge?()`，全绿 → 隐藏）。
  在 `tool/result`/`turn/end` 时重算并缓存，启动时按 session 回填（resume 也点亮）。
- **TUI `/fix`**：检测失败 → 展示摘要 → 组装修复请求块（命令 + 退出码 + 分类 +
  输出尾部 + full-output 路径）走 `evalTurn` 送 agent 求修复。`/fix --show`/`--dry`
  只展示不发送；`busy` 时拒绝。
- **`AIH_ERROR_DETECT=0`**：关闭自动指示（显式 `/fix` 始终可用）。

### `?` 前缀快捷任务 + 上下文注入（IT#3）

TUI 输入行以 **`?`** 开头即启动一个 agent 任务，**自动注入当前上下文**（借鉴
Intelligent Terminal "type `?` + prompt, injects active pane context"）。纯 seam
`cli/src/question.ts`（无 I/O、无 LLM、可单测）：

- **`classifyQuestionPrefix`**：`?` + 空格 + 文本 / `?` + CJK（无空格）→ 任务；
  裸 `?`、`?foo`（`?` 紧贴 ascii）、句尾 `?`、无 `?` → **不**误判（literal）。
- **`buildQuestionContext`**：复用 IT#1 shell-context 组装上下文块（最近 shell 输出 +
  cwd + 活动 session）；空 log → 仅 cwd，不注入噪声。
- **`composeQuestionPrompt`**：上下文块 + `Task: <prompt>` 合成单条 prompt 送 agent。

### 多 agent 会话管理面板（IT#4）

TUI **`/sessions`** 常驻会话管理面：列出活跃 agent 会话 + 状态 + token 用量与成本
（借鉴 Intelligent Terminal "track active agent sessions and their status"）。纯 seam
`cli/src/sessions.ts`（无 I/O、无 LLM、可单测）：

- **dashboard**：active（job-backed，newest-first）+ saved（非 job，idle）双区，
  聚合 `totalTokens` + `totalCost`（有价目表时）。
- **`/sessions kill <id>`**：取消运行中的后台 job。
- **`/sessions view <name>`**：单 session 的 token/cost 摘要。
- 状态映射 running / done / failed / cancelled；空态 → `(no sessions yet)`。

### 命令批准 run-or-copy（IT#5）

agent 建议一条 **write 类** `run_cmd` 命令时，批准提示不再是笼统的
`[y]es/[n]o/[a]lways`，而是显式 **`[R]un / [C]opy / [N]o`**（借鉴 Intelligent
Terminal "gives you the option to run or copy it rather than running it
automatically"）——**默认不自动执行**：

- **`R`（run）**：批准执行该命令。
- **`C`（copy）**：把命令**复制到剪贴板**（`pbcopy`/`wl-copy`/`xclip`/`xsel`/`clip`
  探测，`cli/src/clipboard.ts`），**不执行**；无剪贴板时降级为**打印命令**供手动粘贴。
- **`N`（no）**：拒绝。
- **读类命令**仍走 CC#54 auto-allow 白名单（`ls`/`cat`/`grep`… 自动放行，不弹
  run-or-copy）；非 `run_cmd` 的 write ask 保持通用 `[y]/[n]/[a]`。
- 兼容性：未实现 `askRunOrCopy` 的 TUI（如测试 stub）自动回退 `askConfirm`，
  CC#54 契约不破（`gate.ts` 路由时探测）。

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

### 分支蒸馏（distill-branch，P#37）

放弃一个分支时，"被扔掉的路上学到了什么"不必跟着丢：

- `aih session distill-branch <废弃会话> <目标会话> [--from seq]` 用**一次无工具
  LLM 调用**把废弃分支的转写（工具正文截断、输入封顶 24k 字符）蒸馏为 3–6 条可迁移
  经验，作为 `branch_summary` 事件**追加**到目标会话——原文件不动，append-only 可审计
- `deriveMessages` 把 branch_summary 折叠进首条 system 消息（与 compaction 投影共存），
  存活分支保留死路的知识而无需承担其 token 成本；蒸馏提示词只取"为什么失败/发现的约束/
  关键路径与命令"，不含密钥
- 冒烟测试覆盖：投影折叠（含与 compaction 并存）、CLI 蒸馏落盘与缺失目标拒绝

### Eval 实验框架（P#46）

"A/B 两个模型跑同一批任务各 N 次，产出可比的结果内核"——现代智能体项目的可信度门槛：

```sh
# 编程接口（cli/src/eval.ts）：tasks × models × repetitions → cell 矩阵
runExperiment(tasks, models, reps, subject, { outDir, budget })
```

- **SubjectAdapter seam**：eval 只拥有实验语义，执行复用各 subject 自身运行时——
  内置 CLI（`cliSubjectAdapter`）、任意外部命令（`externalSubjectAdapter`，
  `{prompt}`/`{workdir}` 模板展开，可对比其他 agent CLI）、HTTP 端点
  （`httpSubjectAdapter`，打 `aih serve POST /message`）
- **预算控制**：墙钟（`budgetMs`）与成本上限（`maxCostUsd`，按 F#30 价目表从各
  attempt 会话日志的 turn/end usage 定价）；预算耗尽后未启动的 cell 进
  `skippedCells`——诚实记账，绝不伪造结果；并发上限默认 `AIH_TOOL_CONCURRENCY`
- **结果内核**：`{ status, durationMs, outputTail, failureReason, usage, costUsd }`；
  attempt 不可变，多 attempt 取最早有效者（反 Goodhart）
- **CLI 面（FA#6 失败单题重跑）**：`aih experiment`（`aih eval` 已是仓库 QA 门禁，故实验
  框架单列命令）——
  ```sh
  aih experiment run <spec.json> [--exp-id id] [--mock] [--reps N] [--concurrency N]
  aih experiment retry <spec.json> --exp-id id   # == run --retry-failed：只重跑非 passed cell
  aih experiment status <exp-id> [--json]         # passed/failed/error 分布
  ```
  spec：`{ "tasks": [{id, prompt, expect[]}], "models": [{model, provider?, baseUrl?}],
  "repetitions": N }`。每 cell 的 `status` 持久化到 `.aih/eval/<exp-id>.results.json`；
  `retry` 只重跑上次 `failed`/`error`/未跑的 cell 并合并回同一结果集（省 token/时间），
  全绿时直接短路。
- 冒烟测试覆盖：cell 展开、mock 全流程 4 cell、紧预算跳过记账、usage 聚合、成本上限
  停机、外部 echo subject 判定、**FA#6 持久化 + 失败单题重跑（只跑失败 cell、passed 保留）
  + status 分布检视**

### 成本与吞吐（cost / TPS）

会话级成本与吞吐统计（roadmap F#30，对齐 MiMo context sidebar）：

- **价目表**：`cli/src/cost.ts` 内置常见模型 $/1M 价格（OpenAI / Anthropic / Google /
  DeepSeek / Qwen / Meta）；`aih.json` 的 `prices` 键可覆盖（`{ "gpt-4o": { "input": 2.5, "output": 10 } }`），
  匹配为归一化子串——dated id（`gpt-4o-2024-11-20`）命中 `gpt-4o` 行
- **三处展示**：TUI Context 面板加 `cost $x.xx · N tok/s` 行；`/usage` 输出累计成本 + 吞吐；
  `aih stats`（非交互）输出成本 + 吞吐
- **TPS** 为会话平均吞吐（总 token / 时间跨度），数据可推导、可单测；
  **逐请求流式 TPS 已交付**——`streamingTps()` 用完成 token / 真实生成毫秒
  （`turn/end.genMs`，流式响应自请求至末个 delta 计时），三处展示为 `stps` /
  `stream N tok/s`；mock / 非流式无 `genMs` 时为 0
- 无价目表匹配时成本显示 `—` 并提示配置 `prices`；mock 模式无 usage 数据，成本/TPS 不显示
- 冒烟测试覆盖：价格解析（精确/子串/大小写/用户覆盖/未命中）、成本计算、TPS 边界、格式化

### 记分卡（harness scorecard，PE#3）

「不要数 token，要数**无需人工干预且产出可接受证据的完成任务数**」（Production Agent
Engineering 6 层 Playbook 的核心指标）。`aih scorecard [--format json]` 从现有
append-only 会话日志 + `.aih/memory.md` 纯函数算出 6 项健康指标——**无新存储、零重依赖**：

- **completion rate** = goal-met / turn（验证完成率，↑）
- **rework rate** = 失败 tool 调用 / turn（返工率，↓）
- **escalation rate** = escalate 事件 / turn（人工介入率，↓，PE#4 原语）
- **recovery time** = 失败 tool → 下一次成功调用的最大间隔（恢复时长，↓）
- **cost per verified** = 总成本 / 验证数（每验证结果成本，↓，复用 F#30 价目表）
- **guide growth** = memory 中 dated 规则数 / 会话跨度（规则增速，理想→下降）

载体：`cli/src/scorecard.ts`（纯函数 `computeScorecard` / `formatScorecard` /
`countDatedEntries`）+ `cli/src/index.ts` `scorecard` 子命令；数据源 = 现有会话日志
（`turn/start`、`goal/judge`、`tool/result`、`escalate`、`turn/end.usage`）+ 项目记忆。
无价目表 / mock 模式下成本项为 `—` / 0，其余指标照常。冒烟覆盖：6 指标数值、
recovery 跨度、guide 增速（含短跨度不外推）、空会话全 0 不报错、bullet-dated 记忆行计数。

### 安全缝（safety seam，PE#1 / PE#2 / PE#4）

「让 harness 强制，而不是让模型自律」——Production Agent Engineering 的护栏层。
三件套在**每步工具执行后**由内核统一裁决，模型不可见、不可绕过：

- **PE#2 预算硬约束 + 熔断（budget）**：`BudgetTracker` 累积**成本 / 写次数 / 墙钟时间**，
  并守住 **scope 拒绝清单**（`denyPaths` 命中的写立即硬违规）。
  - **硬边界**（`maxCostUsd` / `maxWrites` / `timeoutMs` / `denyPaths`）任一越界 →
    抛 `BudgetExceeded` → 内核发 `escalate` 事件、`turn/end stopReason="escalated"`，**停止本轮**。
  - **软熔断（tripwire）**：单任务成本 ≥ 2× 会话均值 → 经 `onTripwire` 钩子**提示一次**（每任务
    锁存一次），**不阻断**——把「异常贵」变成可见信号而非静默烧钱。
- **PE#1 计算式传感器（sensors）**：写后验证。声明 `{name, command, onTools?, pathPrefix?, timeoutMs?}`，
  在指定写工具成功后跑一条命令（`cwd`=项目根，`buildChildEnv` 保证子进程**拿不到密钥**）。
  退出 0=绿；非 0=红→**有界重试**（`sensorRetries`，默认 1）→仍红则**升级**。
  `onTools` 限定触发工具、`pathPrefix` 限定写入路径，避免无关写触发昂贵检查。
- **PE#4 升级原语（escalate）**：harness 遇到「自己解决不了」的边界（传感器持续红、预算越界、
  反复失败）时，发一条**模型不可见**的 `escalate` 事件（`reason` + `options[2-4]` + `safestDefault`），
  把决策交还给人：
  - **交互（TUI）**：渲染选项 + 最安全默认，等待人工选择；
  - **非交互（`run`）**：打印选项与 safest default 后**以退出码 3 停止**（`ESCALATE_EXIT_CODE`），
    让 CI / 脚本能区分「正常结束」与「需要人介入」。

配置（`aih.json` `safety` 块，或 env 覆盖，后者胜）：

```jsonc
{
  "safety": {
    "budget": { "maxCostUsd": 1, "maxWrites": 5, "timeoutMs": 60000, "denyPaths": ["secrets/"] },
    "sensors": [
      { "name": "typecheck", "command": "npm run typecheck", "onTools": ["write_file", "edit"] }
    ],
    "sensorRetries": 1
  }
}
```

env 等价：`AIH_BUDGET`（JSON 或 `maxCostUsd=1|maxWrites=5|timeoutMs=60000|denyPaths=a|b`）、
`AIH_SENSORS`（SensorConfig JSON 数组或单对象）、`AIH_SENSOR_RETRIES`（默认 1）、
`AIH_SENSOR_TIMEOUT_MS`（默认 60000）。**未配置时整条缝 no-op**（零开销、零行为改变）。

载体：状态机在 `core/src/budget.ts`（`BudgetTracker` / `SensorLoop` / `parseBudget` / `isDenied`，
纯函数可单测），裁决在 `core/src/agent-loop.ts`（`escalate()` + 每步后 sensor/budget 检查），
CLI 接线在 `cli/src/safety.ts`（config→core 对象 + 传感器执行器 + `onEscalate` 行为）。
冒烟覆盖：预算 cost/writes/timeout/scope/tripwire/parse、传感器绿/红/重试/升级/pathPrefix、
AgentLoop 集成（传感器红→escalate、预算硬→escalate、tripwire→继续）。
**恢复测试**：`test/recovery.sh`（escalate 落盘可回放 + 非交互退出码 3 + 崩溃后续跑不重复派发）。

### 距离尺（`aih measure`，PR#2）

scorecard 回答「现在有多好」（单点），`aih measure` 回答「变了多少、怎么变的」——
Proteus「measurement instrument, not just a score」的距离尺。纯函数（`cli/src/measure.ts`，
同 cost.ts/scorecard.ts 纪律，无 LLM 可单测），**只读声明的 surface + 归一化 trace，从不读
agent 自述、不给 harness 插桩**。三个子命令，`--json` 出结构化结果：

- **`aih measure distance <a.json> <b.json>`** —— 每 surface 的结构距离：`added`/`dropped`/
  `revised` + `pathLength`；`--revised surface=entry,entry` 声明「同在但已变」的条目。
  **缺快照→明确 degraded（exit 1）而非虚构大距离**。
- **`aih measure stream <traces.json> [--perms N] [--seed N]`** —— 行为距离：工具流频率 L1 +
  转移 bigram Jaccard，配 **seeded 置换检验**（between/within 比 R + p；同 seed 完全可复现；
  arm<2 时 degraded 不硬算）。
- **`aih measure crystallize <evolved.json> <neutral.json>`** —— 进化态挂中性条件读回是否等于
  自身端点（disposition 稳定判定）；drift → **exit 1 有信号**、`DRIFTED` 标记。

输入 schema：`{ "surfaces": [ { "surface": "skills", "entries": ["a","b"] } ] }` 与
`{ "traces": [ { "label": "arm", "events": [...] } ] }`。冒烟覆盖结构距离精确 diff、置换检验
可复现、缺快照降级、CLI 端到端 —— 见 `cli/src/smoke.ts` PR#2 块。

### Persistent Memory（持久记忆）

`.aih/memory.md` 是 agent 自己维护的持久知识（与 APP.md"人写契约"分离）：

- `remember` 工具写入：`action=append` 追加带日期条目 / `action=set` 整体重写；
  `scope` 可选 `project`（`.aih/memory.md`）/ `user`（XDG 用户目录 `memory.md`）
- 每轮自动注入 system prompt（项目 + 用户两级合并，预算 `AIH_MEMORY_BUDGET`，
  默认 4000 字符，超出截断）
- TUI `/memory` 查看当前记忆；`/tidy [project|user]` 确定性去重
  （保留最新日期副本，`/tidy apply` 写入）

### Dream / Distill（会话即资产）

把历史会话当作可复利资产（roadmap P2#7，`cli/src/dream.ts` 纯函数模块 + TUI 命令）：

- **`/dream`**：扫描最近 5 个会话（每会话最多 40 轮，封顶），抽取"值得记住"的素材——
  用户纠正/偏好（中英关键词启发式）、checkpoint 备注、goal/judge 理由、重复流程；
  一次无工具 LLM 调用把素材蒸馏为 ≤5 条 memory 候选。**只建议、不自动写**——
  用户审阅后用 `remember` 工具落盘（保持"记忆写入需人确认"的边界）
- **`/distill`**：确定性提取重复流程——同一工具 + 同一归一化参数签名出现 ≥3 次
  （`run_cmd` 命令 / `webfetch` URL 去尾斜杠 / 文件类 path）即为 skill/workflow 候选，
  附建议（如 `npm test` ×N → "wrap as a workflow phase"）
- 边界：`/dream` 无素材时直接报告"nothing notable"不调 LLM；LLM 失败回退打印原始素材；
  扫描全程有界（5 会话 × 40 轮），大日志不爆
- 冒烟测试覆盖：flow 阈值/排序/URL 归一化、dream 素材四类抽取、格式化渲染、空会话 no-op

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
**模型级** `models[<id>].contextWindow` > `providers.<name>.contextWindow` / `contextWindow`
> 默认 128k）。llama.cpp 服务端把总窗口按并行槽数（`parallel`）分好后，就在 `/slots` 里
以每 slot 的 `n_ctx` 上报，因此"2 并行 256k"自动解析为 128k，无需手算；非 llama.cpp 端点
或探测失败时静默回落到配置值：

```jsonc
// aih.json — 配置值作为探测失败时的回退（可选）
{ "defaultProvider": "qwen",
  "providers": {
    "qwen":     { "model": "qwen3-27b",  "contextWindow": 131072 },
    "deepseek": { "model": "deepseek",   "contextWindow": 65536  }
  } }
```

**按模型声明窗口（F#34）**：一个 provider 挂多个模型时，provider 级 `contextWindow`
对所有模型一刀切。`models[]` 支持对象形式 `{ "model": "<id>", "contextWindow": <n> }`，
只对该模型生效（字符串与对象可混用），TUI 面板 / `/model` 切换 / `aih config` 全部跟随：

```jsonc
{ "providers": {
    "opencode": {
      "baseUrl": "https://opencode.ai/zen/v1",
      "model": "big-pickle",
      "contextWindow": 200000,                       // 主模型（provider 级）
      "models": [
        { "model": "x-preview-f-free", "contextWindow": 1000000 },  // 1M
        { "model": "hy3-free",         "contextWindow": 190000 }    // 190k
      ]
    } } }
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
npm run cli -- session distill-branch branch-a default --from 7  # 废弃分支蒸馏为 branch_summary 注入目标会话
# TUI 内：/checkpoint [note] 与 /restore [seq]（回滚前自动快照完整历史）
npm run cli -- session rm work                    # 删除
npm run cli -- stats                              # 所有会话 token 用量汇总
npm run cli -- scorecard [--format json]          # harness 健康记分卡（6 指标，PE#3）
npm run cli -- measure distance <a.json> <b.json> # 结构距离（added/dropped/revised+len，PR#2）
npm run cli -- measure stream <traces.json>       # 行为距离 + 置换检验 R（seeded，PR#2）
npm run cli -- measure crystallize <e> <n>        # 进化态中性读回 vs 端点（drift→exit 1）
```

会话文件为 append-only JSONL（每行一个 SessionEvent），可直接审计或程序化回放。
每次工具调用另追加到 `.aih/tool-audit.jsonl`（ts/tool/args[4KB]/ok/error），
含 `task` 子代理内部调用；`--no-audit` 关闭。"模型可见即已记录"不变量。

### Subagent System（子代理）

`task` 工具派发子代理：独立上下文、≤8 步、不可再嵌套，返回最终答案。
`task` 本身免审，但其子代理调用的每个工具仍走各自权限门。

### Max Mode（并行子代理 + best-of-N 裁判）

`best_of_n` 工具对同一 prompt 并行派发 N 个独立子代理（N 默认 3、封顶 8；
并发受 `AIH_TOOL_CONCURRENCY` 限制，结果按原序收集），再用一次**无工具**的
LLM 裁判调用从候选答案里选出最佳（`{"best": <index>, "reason": "..."}`，
越界/解析失败回退到第一个成功候选）。全部失败则整体报错；仅一个成功则直接
采用（跳过裁判）。实现：`cli/src/maxmode.ts`（`runSubagent` / `mapOrdered` /
`parseJudgeVerdict` / `bestOfN`），零新依赖，复用 core `AgentLoop` +
`ToolRegistry`。冒烟覆盖：裁判解析/越界回退、`mapOrdered` 顺序与并发上限、
N=3 全流程、n 钳制、全失败路径、子代理防递归（剔除 task/question/best_of_n）。

两个可选增强（借鉴 CodebuffAI/freebuff，roadmap FB#1 / FB#2）：

- **多策略模式（FB#1）**：传 `prompts`（一组短策略提示）后，候选 i 在**共享
  任务上下文**之上叠加自己的策略方向（`prompts[i % len]`）——比 N 个同 prompt
  采样探索面更广。结果带 `strategies` 字段，裁判给每个候选标注
  `[strategy: …]`，可权衡"方法对不对"而非只看"答案对不对"。省略 `prompts`
  → 单 prompt 行为不变。
- **双裁判面板（FB#2）**：设 `AIH_SECOND_JUDGE_MODEL` 后启用第二裁判——两裁判
  **并行**（`Promise.allSettled`），保留主裁判的选择（两个意见的中位）；**分歧**
  或**任一裁判失败**都标记 `judgeDegraded` 并在 stderr 警告（绝不静默丢弃一个
  裁判——丢弃 = 面板退化成单意见）；双裁判都失败 → 硬错误。缺省 → 单裁判
  行为不变。面板是通用 `judgePanel<V>()`，`/goal` 裁判可共用同一套纪律
  （roadmap FB#6）。

### Agent Teams（roster + 任务板 + mailbox）

在子代理原语之上的协作层（roadmap D#15）：`.aih/team/` 下的纯文件团队工作区，
`aih team` 管理名册、任务板与每 agent 的 mailbox：

```sh
aih team add-agent scout --role research --prompt "You are a careful researcher."
aih team add-task "write the report" --detail "draft v1"
aih team claim <task> --as scout
aih team dispatch <task> --as scout   # 跑一个同步 agent turn，结果镜像回任务板
aih team done <task> --note "shipped"
aih team mail builder "report ready" --sender scout
aih team inbox builder [--unread]
aih team list                         # 名册 + 任务板 + inbox 计数
```

任务 id 支持唯一前缀解析；`dispatch` 复用 D#13 的 `spawnJob`（作业板
`.aih/jobs.json` 记录运行态），完成后把 done/failed + 预览写回任务板；
需要后台并行时用 TUI `/bg`（长驻进程持有子进程句柄）。

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

**技能相关性自动加载**（roadmap P1#4，`cli/src/bm25.ts`）：每轮开始前用 BM25
对已装技能做相关性排序（CJK 按字符 bigram 分词），命中技能以"建议加载"提示
注入本轮上下文，模型可直接 `load_skill`；`aih skills suggest <query>` 可离线
查看同一排序。另：`SKILL.md` front matter 支持 `secretPatterns`（见"安全与调试"）。

### 后台任务（`/bg`）与沙箱 seam

- **后台任务**（roadmap D#13）：TUI `/bg <prompt>` 把一次 agent turn 派生成
  后台子进程（`aih run --session bg-<id>`），TUI 保持响应；状态行实时显示
  running/done/failed 计数，完成时把最终答案作为 system 消息回显；
  `/bg list` / `/bg cancel <id>` 管理；作业板落 `.aih/jobs.json`，重启 TUI 仍在。
  `distill` / `tidy` 等纯 CLI 子命令也可作为后台作业派发。
- **沙箱 seam**（roadmap D#12）：`run_cmd` 的执行后端可替换——
  `local`（默认）/ `bwrap` / `remote`（`cli/src/sandbox.ts` 的 `SandboxBackend`
  接口，`AIH_SANDBOX` 或工具参数 `sandbox` 选择）；先定接口，默认本地。

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

### 信任模型（OC#4 — 本地单算子，非多租户安全边界）

AIH 的威胁模型是**本地单算子**：

- **信任边界 = 宿主 OS 用户**。能操作该 agent 的人就能让 agent 做任何 agent 能做的事。
  session 的所有权/可见性是**可用性特性，不是安全边界**——不要把它当隔离手段。
- **prompt-injection-only 链不算安全 bug**：仅靠「模型被诱导」而**没有**越过下列任一硬边界的
  路径不在威胁模型内。硬边界 = `allow/ask/deny` 权限门（`ApprovalGate`）、凭据脱敏与
  owner 隔离（`redactCredential` / 降级而非 fallback）、sandbox seam（默认 local，可切
  bwrap/remote）、工具注册表的 `deny` 红线。越过其中任一才算安全事件。
- **需要真隔离时**：用独立 agent / 独立宿主（独立 OS 用户或容器）建立新信任边界，而不是
  指望 prompt 或 session 隔离。
- **对手模型**：默认对手是「同宿主用户」与「不可信的外部内容（网页/工具输出）」；外部内容
  只能影响模型意图，不能直接触达 deny 红线或凭据——除非它诱导模型主动调用一个被 allow/ask
  放行的工具，而那属于用户对权限配置的决策。

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
  `/inject <text>` `/events` `/skills` `/vivid` `/bg <prompt>` `/find <text>` `/shell [--send]` `/fix [--show]` `/ <技能名>`
- **`/find <text>`**：跨所有工具输出逐行检索（含 32KB 内带上限的展开内容），
  命中工具自动展开并滚动到首个命中，列出最近 12 条命中（`tool · line · 片段`）；
  超出内带上限的全量输出用 `run_cmd keep_output=true` 落盘 `.aih/outputs/*.log`
- **`/shell [--send]`**（IT#1 shell 上下文感知）：展示本会话最近的 `run_cmd` 上下文
  （命令 · 退出码 · cwd · 输出尾部，`keep_output` 时附全量输出文件路径）；
  `--send` 把该上下文块注入下一 turn。agent 侧另有 `shell_context` 工具可主动取用
  （`max_commands`/`max_output_chars` 可调），或设 `AIH_SHELL_CONTEXT=auto` 在每个
  正常消息 turn 起始自动附带——免去手动粘贴 shell 报错/输出
- **`/fix [--show]`**（IT#2 确定性 error-detection）：检测本会话失败的 `run_cmd`
  （非零退出码 / 超时），展示摘要（命令 · 退出码 · 分类），组装修复请求块送 agent
  求修复；`--show`/`--dry` 只展示不发送。状态栏在失败后亮红色 `⚠ N failed`
  （全绿隐藏；`AIH_ERROR_DETECT=0` 关闭自动指示）
- **`/vivid` 简洁渲染**：切换 plain 模式——去掉边框/底色/侧栏/状态提示等 chrome，
  只留正文（适合低带宽/远程/日志回放）；再按一次还原完整主题
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
| `webfetch` | 抓取 URL → 纯文本（HTML 转 text，64KB 截断）。浏览器级 UA + Accept 头、网络失败有界重试 1 次、Cloudflare 403 challenge 自动换诚实 UA 重试、`timeout` 参数（秒，默认 30、上限 120）、下载前 content-length 预检、失败信息可操作（提示替代端点/websearch） | allow |
| `websearch` | DuckDuckGo 搜索（标题/URL/摘要，免 key） | allow |
| `task` | 派发子代理（独立上下文、≤8 步、不可再嵌套） | allow* |
| `apply_patch` | 多文件补丁（Add/Update/Delete/Move，opencode 格式） | ask |

plan 模式下所有 `ask` 写工具自动隐藏。未对齐 opencode 的仅 `lsp`（语言服务器基建）
与实验性 `execute`(code-mode)——前者属 MCP 外挂范畴，后者由 run_cmd + roadmap 沙箱
seam 覆盖。除工具集外，opencode 的 `rules`（AGENTS.md/CLAUDE.md/instructions）、
`policies`（provider.use）、`keybinds`（tui.json）三块能力也已对齐——见 Configuration 节。

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
- **工具结果脱敏 + 计时钩子**（roadmap D#11）：默认开启的内置钩子在工具结果
  进入 LLM / 会话日志 / 审计前，把常见凭据形状（`sk-…` / `ghp_…` / `AKIA…` /
  `xox…` / `api_key=…` 等）替换为 `[REDACTED]` 并附 `redacted: N` 计数与
  `duration_ms` 计时；`--no-redact` 关闭脱敏。技能可在 `SKILL.md` front matter
  用 `secretPatterns`（分号分隔的正则源）声明额外秘密形状，非法正则自动跳过，
  内置表始终生效。实现见 `cli/src/hooks.ts`。

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

优先级：**flag > 环境变量 > 项目 `aih.json`/`.aih/config.json` > 全局用户配置**。

全局用户配置按 **XDG 数据目录规范**解析（`cli/src/paths.ts`）：
`AIH_HOME` > `$XDG_DATA_HOME/aih` > `~/.local/share/aih`；旧版 `~/.aih` 在 XDG
目录不存在时**仍可读**（平滑迁移，已存在的旧配置不丢）。

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

`aih config` 打印生效配置及各字段来源；`aih models` 列出所有 provider。

**编辑器补全（`$schema` 注入）**：在 `aih.json` / `config.json` 顶部加
`"$schema": "https://aih.dev/schema/aih.schema.json"` 即获得字段自动补全与校验；
`aih config --schema` 直接打印该 JSON Schema（本地文件 `cli/schema/aih.schema.json`）。

**一个 provider 挂多个模型**：`model` 是主模型，`models[]` 列出同一端点下额外
可切换的模型（共享该 provider 的 `baseUrl` / `headers` / `apiKeyEnv`）。每个模型
在 `aih models` 与 TUI 的 `ctrl-p` 模型选择器里各占一行，用
`/model <provider>/<model>` 或直接点选即可热切换——适合把免费档 / 多档模型
都挂在一个端点下随时切。

### 规则（`AGENTS.md` / `CLAUDE.md` / `instructions` — opencode `rules` parity）

AIH 现在会读取并注入项目/全局规则文件作为**强制性指令**（对齐 opencode 的
`rules` 机制，此前只读 APP.md 应用契约）。加载顺序（同类中第一个命中优先）：

1. **项目规则** — 从 `cwd` 向上逐层找 `AGENTS.md`（无则回退 `CLAUDE.md`）；
2. **全局规则** — `~/.claude/CLAUDE.md`（Claude Code 兼容，`AIH_DISABLE_CLAUDE_CODE=1`
   关闭，`AIH_DISABLE_CLAUDE_CODE_PROMPT=1` 只关此文件）；
3. **配置 `instructions`** — 任意已信任配置层的 `instructions` 数组（路径 / glob /
   远程 URL）。

```json
{
  "instructions": ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md"]
}
```

规则内容被合并进系统提示的 `# Project rules` 段（每条 6000 字符预算），标记为
`mandatory`，且会覆盖默认行为。Claude Code 兼容可在 `AIH_DISABLE_CLAUDE_CODE`
家族环境变量下按需关闭。

### 策略（`policies` — opencode `policies` parity）

`policies` 控制**哪些已配置的 LLM provider 可用**，与 `permissions`（管工具）
正交——被 deny 的 provider 即使配了凭据也不可选、不可用。资源支持 `*` / `?`
通配；**最后一个匹配的语句生效**（因此宽规则放前、特例放后）；全局策略优先于
项目策略（仓库无法重新启用你在全局 deny 的 provider）；无匹配默认放行。

```json
{
  "policies": [
    { "effect": "deny", "action": "provider.use", "resource": "*" },
    { "effect": "allow", "action": "provider.use", "resource": "opencode" }
  ]
}
```

以上配置只允许 `opencode` provider，其余全部不可用。

### 快捷键（`tui.json` — opencode `keybinds` parity）

核心操作键位可通过 `tui.json`（cwd 项目级 + `~/.aih/tui.json` 全局）重绑，全局
覆盖项目。支持 `ctrl+<letter>`、`tab`、单个可打印字符、`none`（禁用）。与内置
保留键（Enter/Ctrl+C 等）冲突的映射会被丢弃并告警。

```json
{
  "keybinds": {
    "palette": "ctrl+x",
    "toggleMode": "none",
    "help": "?"
  }
}
```

默认：`palette=ctrl+p`、`help=?`；`toggleMode` 默认不设独立键（Tab 已经驱动
补全与 build/plan 切换）。`Alt+…`/功能键属转义序列，超出单字节重绑范围。

### 凭据所有者隔离（OC#7 — OpenClaw「secrets have owners」）

一条凭据失败时**只降级它的归属者（owner）**，绝不静默 fallback 到另一条凭据。
AIH 的 owner 即一个已配置的 LLM provider（`empero` / `llamacpp` / `zhipu` /
`opencode` …）。语义：

- **可隔离降级** — provider 出现凭据类失败（401/403 认证、或配额耗尽）时，该
  owner 被标记为不可用，在**用户级** `owner.json` 记录**脱敏**原因；原错误仍
  照常抛出（不会自动换到别的凭据）。之后的一次**成功调用会自动清除**该降级。
- **硬失败阻止启动** — 缺少必需 API key、未知 provider、被 policy deny 的
  provider，都在解析时直接 throw（fail-closed），不降级糊弄。
- **报告** — `aih models` 会在降级 provider 行标 `⚠ degraded`，并在末尾打印
  `degraded owners` 报告（含脱敏原因）；`aih stats` 同样打印该报告。
  `aih models --clear-degraded` 重置脱敏登记。

```text
$ aih models
provider               model                       base-url
...
opencode ⚠ degraded    gpt-5.1-codex              https://opencode.ai

degraded owners:
  - opencode [credential] x2 @ 2026-08-31T…: llm request failed: HTTP 401 [redacted]
  (clear with: aih models --clear-degraded)
```

选择另一个（未降级）owner 仍是**显式用户决策**——不是自动 fallback；`/model`、
`--provider` 切到其它可用 provider 依然正常。实现见 `cli/src/owner-state.ts` +
`core/src/seams/llm-openai.ts`（`onCredentialFailure` / `onOwnerSuccess` 钩子）。

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
| `AIH_HOME` | 全局用户配置/数据目录（最高优先级，覆盖 XDG 默认） |
| `XDG_DATA_HOME` | XDG 数据基目录（全局配置落到 `$XDG_DATA_HOME/aih`） |
| `AIH_RETRIES` (1) | LLM 429/5xx 自动重试次数（鉴权错误不重试） |
| `AIH_FIRST_TOKEN_TIMEOUT_MS` (180000) | 流式响应首 token 超时（0 关闭）；超时后带部分内容的断流触发**断流续传**（保留 partial 文本 + 有界续跑一次），无内容的计入重试预算 |
| `AIH_STALL_TIMEOUT_MS` (60000) | 流式响应帧间 stall 超时（0 关闭）；语义同上 |
| `AIH_QUOTA_AUTO_RESUME` (1) | 配额耗尽（429/402 + quota/limit/credits 或 Retry-After ≥ 60s）时交互会话自动等待重置后**重发被拒调用**（有界 2 次，TUI 显示等待行）；`0` 关闭。非交互 `run` 恒快速失败 |
| `NO_COLOR` | 关闭彩色输出 |
| `AIH_CONTEXT_WINDOW` (默认 131072) / `AIH_COMPACT_AT` (0.8) | 上下文窗口与压缩阈值（窗口优先级：`--context-window` > env > llama.cpp `/slots` 实时探测 > aih.json `models[<id>].contextWindow` > `providers.<name>.contextWindow` / `contextWindow`） |
| `AIH_GOAL_ROUNDS` (3) | `/goal` 与 `run --goal` 的额外续跑轮数上限 |
| `AIH_MEMORY_BUDGET` (4000) | 每轮注入 memory.md 的字符预算 |
| `AIH_CMD_TIMEOUT_MS` (120000) | run_cmd 默认超时 |
| `AIH_TOOL_CONCURRENCY` (4) | 单步内连续只读工具调用的并发上限（写类恒串行） |
| `AIH_FORMAT_TIMEOUT_MS` (15000) | 写后自动格式化超时（失败不阻断写入） |
| `AIH_FETCH_TIMEOUT_MS` (30000) | webfetch 默认超时（工具 `timeout` 参数优先；硬上限 120000） |
| `AIH_MOCK_AUX_TEXT` | mock 模式下无工具辅助调用（goal 裁判 / 分支蒸馏）的回复文本（测试钩子） |
| `AIH_SECOND_JUDGE_MODEL` | `best_of_n` 第二裁判的 model id（FB#2 双裁判面板；复用主模型的 provider/base-url/api-key，缺省 → 单裁判） |
| `AIH_BUDGET` | PE#2 预算硬约束：JSON 或 `maxCostUsd=1\|maxWrites=5\|timeoutMs=60000\|denyPaths=a\|b`（越界→escalate 退出码 3） |
| `AIH_SENSORS` | PE#1 计算式传感器：SensorConfig JSON 数组或单对象（写后验证命令，红→有界重试→升级） |
| `AIH_SENSOR_RETRIES` (1) | PE#1 传感器红→升级前的重试次数 |
| `AIH_SENSOR_TIMEOUT_MS` (60000) | PE#1 单条传感器命令超时 |

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
| 流式断流防护+诚实续传（stall 看门狗） | — | ◐ | ◐ | — | ✅ CC#49（首 token/帧间超时，partial 保留+有界续跑） |
| 配额耗尽自动等待+重发被拒调用 | — | ◐ | ◐ | — | ✅ CC#51（quota/limit/credits 或 Retry-After≥60s，交互自动续、run 快速失败） |
| 结构化 checkpoint 回滚 | — | ◐ snapshot | ◐ | — | ✅ `/checkpoint`+`/restore`（F#28，append-only） |
| 项目记忆（memory.md + 注入预算） | — | — | ✅ | — | ✅ |
| Goal 裁判自动续跑 | ✅ goals | — | ✅ | — | ✅ |
| 子代理 / 多 agent | ✅ teams | ✅ subagent | ✅ | — | ✅ 串行 `task` + **并行 `best_of_n`**（Max Mode，P2#9）+ **Agent Teams**（D#15） |
| 并行工具调用（读类 ≤N 有界并发） | ✅ ≤10 | ◐ | ◐ | — | ✅ F#29（写类恒串行） |
| 技能层（SKILL.md 三级加载） | — | ✅ | ✅ | — | ✅ |
| plan/build 双模式 | — | ✅ | ✅ | — | ✅ |
| TUI：流式/markdown/侧栏面板/鼠标 | ◐ Web | ✅ | ✅ | — | ✅ |
| 成本 / TPS 实时显示 | — | ◐ | ✅ | — | ✅ 面板 + /usage + stats（F#30，会话平均 TPS） |
| 会话自进化（dream/distill 挖掘记忆+流程） | — | — | ◐ MEMORY | — | ✅ `/dream`+`/distill`（P2#7，只建议不自动写） |
| 确定性 Workflow（阶段脚本） | — | — | ✅ | — | ✅ `.aih/workflows/*.mjs` |
| 写后自动格式化（formatter 集成） | — | ✅ | — | ◐ pre-commit | ✅ prettier>biome>eslint |
| 会话标题/审计留痕/工具钩子 | ✅ | ✅ | ✅ | ✅ decisions | ✅ 审计 + **脱敏/计时 + 技能驱动 `secretPatterns`**（D#11） |
| 工具输出搜索 / 全量落盘 | — | ◐ | ◐ | — | ✅ `/find` + `run_cmd keep_output`（T#22） |
| shell 上下文感知（agent 主动取用 shell 输出/退出码） | — | — | — | — | ✅ `/shell` + `shell_context` 工具 + `AIH_SHELL_CONTEXT=auto`（IT#1） |
| 确定性 shell 失败检测 + 一键修复（状态栏红标 + `/fix` 送 agent） | — | — | — | — | ✅ `error-detect.ts` + 状态栏 `⚠ N failed` + `/fix`（IT#2） |
| 跨 agent 指令契约（AGENTS.md） | — | ◐ | ◐ | ✅ | ✅ |
| curl\|bash 一键安装 | ✅ | ◐ | ✅ | — | ✅ |
| CI 门禁 / 仓库卫生包（CHANGELOG、devcontainer） | ✅ | ◐ | ✅ | ✅ | ✅ ci.yml + CHANGELOG.md + .devcontainer |
| serve/attach 多前端 | ✅ Web | ✅ | ✅ | — | ✅ **HTTP/SSE** `serve`+`attach`（P2#8） |
| XDG 数据目录规范 | ✅ | ◐ | ◐ | — | ✅ `AIH_HOME`>XDG>默认 + `~/.aih` 兼容（P2#9） |
| 配置 `$schema` 注入（编辑器补全） | — | ◐ | ◐ | — | ✅ `aih config --schema` + `aih.schema.json`（P2#9） |
| 简洁/无 chrome 渲染模式 | — | ◐ | — | — | ✅ `/vivid` plain 模式（P2#9） |
| 项目信任门（防克隆仓库投毒） | — | ◐ trust | ◐ | — | ✅ `--trust`/trust.json（P#40，fail-closed） |
| 工具结果修剪 + archive_read 惰性取回 | — | ✅ prune | ◐ | — | ✅ `.aih/archives` + 占位符投影（MK#43） |
| 崩溃恢复（T1 dispatch 事实 + park 不猜） | — | ✅ Runtime Resume | ◐ | — | ✅ tool/dispatch + scanRecovery + PARK 码（MK#44/45） |
| 安全缝（预算硬约束 + 传感器 + escalate 原语） | — | ◐ | — | — | ✅ PE#1 传感器 + PE#2 预算/tripwire + PE#4 escalate（退出码 3，`test/recovery.sh`） |
| 工作区身份 UUID / 覆盖校验压缩摘要 | — | ✅ | — | — | ✅ `.aih/workspace.json` + coverage digest（MK#47/#42） |
| Extension API（代码级插件） | — | ◐ | ✅ Pi | — | ✅ `.aih/extensions/*.mjs` registerTool/Command/on（P#39，信任门约束）+ 结果承载事件（before 否决 / after 改写 / turn:end）+ `init` 自扩展示例 |
| Steering 中途改向 / Follow-up 排队 + Alt+Up 取回 | — | ✅ | ◐→✅ | ✅ Pi | ✅ busy 输入自动 steer；follow-up 自动续跑；Alt+Up 取回排队消息可改后重发（P#35） |
| 缓存命中观测（CH%） | — | ◐ | ◐ | — | ✅ `/usage` 行 + 面板 CH%（P#41，需 provider 上报） |
| 模型元数据快照同步（models.dev） | — | ✅ refresh | — | — | ✅ fail-closed 刷新脚本 + 27 模型快照（P#48） |
| Session 树 / 分支导航 + 分支蒸馏 | — | ◐→✅ | ✅ Pi | — | ✅ parentId 链 + `/tree` 视图 + `distill-branch` branch_summary（P#37） |
| Eval 实验框架（cells/预算/subject seam） | — | ◐ | — | ✅ Maka | ✅ runExperiment 有界并发 + 墙钟/成本预算 + CLI/外部命令/HTTP 三 subject（P#46） |

**相关性 / 借鉴关系**（均已实读代码，吸收映射见 `docs/review-three-harnesses.md`、`docs/comparison-dsh.md`）：

- **deepseek-harness**（agent 运行时平台）→ 借 `Session Log` 回放不变量、`sessions.fork`、`pre/post-execute` 钩子（✅ D#11 脱敏/计时 + 技能驱动）、goals/续跑方向、并行只读工具（≤N 有界并发，✅ F#29）、后台 jobs（✅ D#13）、Agent Teams（✅ D#15）—— 余：沙箱 seam（✅ D#12 接口已留，默认本地）。
- **opencode**（终端 coding agent）→ 借 `build/plan`、**内置通用工具集**（→ AIH `--dev`/general-tools）、pattern+路径权限、`doom_loop`、隐藏系统 agent（compaction/title 已落地）；TUI 交互（忙碌排队/markdown/Tab 补全/滚轮）已对齐；写后 formatter（prettier>biome>eslint，✅ F#27）；checkpoint 回滚（✅ F#28 `/checkpoint`+`/restore`）。
- **MiMo-Code**（opencode fork，交互增强）→ 借 `/goal` 裁判续跑 ✅、MEMORY.md 记忆 ✅、侧栏 Context/Todo 面板 ✅、技能层 ✅、curl|bash 安装器 ✅、用量显示 ✅、确定性 workflow（`.aih/workflows/*.mjs` + `aih workflow run`，✅ F#33）。余：成本/TPS ✅ F#30；side-by-side diff ✅ F#31（双色单元格 + 行号列 + 窄屏回退）。
- **LongHorizon-Harness**（AMAP-ML，长时程 Loop Engineering）→ 借 Final-State Guard（完成诚实规则）+ Task Contract 纪律 + 结构化 goal 契约/扩展裁决（`unmet` 回流续跑指令），以单模型守卫形式落地于系统提示与 `/goal` 裁判 ✅（`core/src/prompts.ts`）；余：MEA 三角色循环（Manager/Executor/Auditor + verified-state ledger，候选 roadmap）。
- **OpenClaw**（openclaw/openclaw，多渠道 AI 助手网关）→ 只借判断层/工程纪律：**核心每调用税 + 重复需求→seam 治理标尺**（OC#2，core 进严审 / 技能·扩展无税鼓励扩张 / ≥2 处独立 wire-in 提取 seam ✅，`docs/decisions.md` + APP.md §6）、修复教义（OC#1，root-cause-first / 生产 LOC 一等约束 / 禁止 consumer-only guard 掩盖根因 ✅）、**live-verify 默认 + 先查现成方案**（OC#3，用户可见行为落地前走真实生产路径 + 自定义前先做简短现成方案门 ✅，`core/src/prompts.ts` `LIVE_VERIFY_DISCIPLINE`）、**信任模型澄清**（OC#4，本地单算子边界 + prompt-injection-only 链不算安全 bug ✅，见权限模型章节后「信任模型」段 + APP.md §3）、凭据所有者隔离（OC#7，降级 owner 而非 fallback 凭据 ✅，见专章）、版本化状态守卫 + 配置自愈（OC#5，schemaVersion + 拒绝开更新版本 + `aih doctor --fix` 把 legacy 配置备份后迁到规范形态 ✅）；明确不借：多渠道网关 / 伴随应用 / ClawHub 市场 / OTel 遥测 / Crabbox 云沙箱 / pnpm monorepo（撞"本地单算子"定位）。
- **Harness-for-codex**（项目级脚手架）→ 借 `AGENTS.md` 单一事实源 + `CLAUDE.md` 桥接 ✅、`harness.yml` 规范 schema ✅、`docs/decisions.md` 留痕 ✅、`verification` 两级门禁（`scripts/eval`）✅；**CI 工作流 = 把 handoff 门禁自动化**（`.github/workflows/ci.yml`，push/PR 跑 check+test）✅。
- **Apache Maka**（apache/maka，local-first agent workspace）→ 借 **事实层纪律**：append-only 事件即唯一事实源、UI/模型调用只是投影。已落地：compaction coverage digest（✅ MK#42，摘要必须证明覆盖范围，否则 fail-open）、tool/dispatch T1 事实 + RecoveryResolver 四态分类 + park 稳定码（✅ MK#44/45）、工具结果修剪 + archive_read 惰性归档（✅ MK#43）、工作区身份 UUID（✅ MK#47）、models.dev 快照 fail-closed 同步（✅ P#48）、steering/follow-up 双队列（✅ P#35）；明确不借 SQLite/Electron、Phase3/4 文件级 reconcile、provider-native 远程压缩。
- **openai/codex**（Codex CLI，Rust）→ 借 `shell_environment_policy`（子进程 env 密钥过滤，✅ `cli/src/env-policy.ts`）、`codex debug prompt-input`（✅ `--debug-prompt` / `AgentLoop.onPromptInput`）、技能名册 2% 上下文预算（✅ `withSkillRoster`）；候选 roadmap：声明式 hooks（`hooks.json` + hash trust）、memories 目录、并行 subagents。
- **Intelligent Terminal**（终端 UX 参考）→ 借 **shell 上下文感知**（agent 主动取用 shell 输出/退出码，✅ IT#1：`/shell` + `shell_context` 工具 + `AIH_SHELL_CONTEXT=auto`）+ **确定性 error-detect→一键送 agent**（✅ IT#2：`error-detect.ts` + 状态栏 `⚠ N failed` + `/fix`）+ **`?` 前缀快捷任务 + 上下文注入**（✅ IT#3：`question.ts` + TUI 输入行识别）+ **多 agent 会话管理面板**（✅ IT#4：`sessions.ts` + TUI `/sessions` dashboard/kill/view）+ **run-or-copy 命令批准**（✅ IT#5：`clipboard.ts` + `askRunOrCopy`）。

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