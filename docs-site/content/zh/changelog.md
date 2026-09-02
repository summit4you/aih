---
title: 更新日志
description: AIH 版本更新日志 —— 0.5.0 / 0.4.0 / 0.3.0 / 0.2.0 / 0.1.0 的主要变更。
---

# 更新日志

完整逐条记录见仓库 [`CHANGELOG.md`](https://github.com/summit4you/aih/blob/main/CHANGELOG.md)（Keep a Changelog 格式，SemVer 版本）。本页为各版本要点摘要。

## 0.5.0（2026-09-02）

**新增**

- **Provider 目录 + `/connect` 交互式接入（对齐 opencode `/connect`，仅 OpenAI 兼容）**——`connectCatalog()` 精选 OpenAI 兼容 provider（热门优先，native-SDK 的 Anthropic/Google 排除）；TUI `/connect` 与 `aih connect [<id>]` 引导选择 provider → 输入 API key（写入 env 文件 chmod 600，**绝不落 aih.json**）→ `saveProvider()` 存入配置（`apiKeyEnv` 命名环境变量，密钥本身不入库）→ 立即应用模型。未配置的 provider 以 "+ connect" 条目出现在 `/model` 选择器底部。
- **双语文档站教程扩展（第 3 批 + 第 19 章 HemaGuide 案例）**、**规则加载（opencode `rules` 对齐）**、**Provider 策略（`policies`）**、**可配置按键（`keybinds`）**、**凭据所有者隔离（OC#7）**、**live-verify / check-existing-first 纪律（OC#3）**、**core 每调用税治理（OC#2）**、**信任模型声明（OC#4）**、**`aih doctor --fix` 配置自愈（OC#5）**、**成熟度记分卡（OC#6）**、**BuffBench 式质量评估 + 基线回归门（FB#4）**。

**修复**

- **模型选择器滚动高亮错位（"选的和显示的不一定"）**：`/model` / ctrl-p 选择器用窗口内循环索引对比全局选中索引，列表超过可见行滚动后高亮与实际选中项漂移；抽取 `paletteWindow()` 返回窗口内高亮位置修齐。
- **切换模型后幻影"上下文爆满/需要压缩"**：免费网关（opencode zen go）报告**累计** `prompt_tokens`（~78K 会话实测 949K / 3.2M）；旧判据 `prompt_tokens ≤ 2×窗口` 在窗口涨到 1M（deepseek-v4-flash）后放行垃圾值，切 big-pickle(200k) → deepseek-v4-flash(1M) 误报"949K ≥ 800K 需压缩"。可信度现在双向对照本地 chars÷4 估算——报告≫估算=累计垃圾（估算胜）、估算≫报告=样本过期（估算胜）。`agent-loop.ts` 与 `cost.ts` 同步修复。

## 0.4.0（2026-08-29）

**新增**

- **安全缝（PE#1 / PE#2 / PE#4）**——让 harness 强制，而非模型自律。**PE#2 预算**：`maxCostUsd` / `maxWrites` / `timeoutMs` / `denyPaths` 硬边界越界即 `escalate` 停轮；软熔断（任务成本 ≥ 2× 会话均值）提示一次不阻断（`AIH_BUDGET` 或 `safety.budget`）。**PE#1 传感器**：写后跑声明的检查（`AIH_SENSORS`），红→有界重试→升级；传感器子进程不继承密钥。**PE#4 escalate**：模型不可见的 `escalate` 事件（`reason` + `options` + `safestDefault`）；非交互 `run` **退出码 3**，TUI 渲染选项。**`test/recovery.sh`**：崩溃→续跑 park 住该工具（结果未知）且不重复派发。
- **Intelligent Terminal UX（IT#1–IT#5）**——**IT#1** `shell_context` 工具 + `/shell` + `AIH_SHELL_CONTEXT=auto`；**IT#2** 确定性失败检测 + 红色 `⚠ N failed` 徽标 + `/fix`；**IT#3** `?` 前缀起 agent 任务并自动注入 shell 上下文；**IT#4** `/sessions` 面板（dashboard / `kill <id>` / `view <name>`）；**IT#5** 写命令 run-or-copy 批准 `[R]un / [C]opy / [N]o`。
- **`aih measure` 距离尺（PR#2）**——`distance` / `stream`（seeded 置换检验）/ `crystallize`；纯函数，`--json` 出。
- **`aih session rm --all`**——真实 `-a/--all` 标志清空全部已存会话。
- **配额自动续跑（CC#51）**、**只读自动放行（CC#54）**、**凭据作用域（CC#59）**、**BOM 容错（CC#55）**、**MCP 空 schema（CC#56）**、**`/usage` 逐循环明细（CC#57）**、**TUI 截断（CC#58）**、**注入源隔离（CC#60）**、**question 工具**、**双语文档站 + GitHub Pages**、**harness 记分卡（PE#3）**、**`escalate` 事件（PE#4 基建）**。

**修复**

- **工具输出预算标记（FA#2）**：旧的晦涩截断标记不再让模型盲目循环——现在会提示它停止重复发工具、就已有内容收尾。
- **语言规则覆盖进度说明**：所有面向用户的文本（最终回答*与*任务中途的进度说明）都跟随用户语言。
- **斜杠命令解析**、**子代理部分结果（CC#50）**、**`load_skill` 去重（CC#52）**、**写工具权限 ask（CC#53）**。

## 0.3.0（2026-08-26）

**新增**

- **逐事件会话持久化**：`chat` 现在在事件发生时即追加落盘（带字节水位增量 flush），长多工具轮次在崩溃/被杀后不再只活在内存里
- **扩展 API（P#39）**：`.aih/extensions/*.mjs` 模块——`registerTool`、`registerCommand`、`on("tool:before" | "tool:after" | "turn:end")` 处理器，可取消调用或就地改写结果；`--no-extensions` 关闭加载，受项目信任门约束
- **会话树（P#37）**：事件携带可选父链接；`aih session tree` 渲染分支结构，TUI `/tree` 导航，可从任意历史点分叉
- **转向 + 后续队列（P#35）**：忙碌中输入不再排队等待，而是在工具批次之间中途落地；后续队列在自然停止点排空
- **项目信任门（P#40）**：仓库提供的扩展/技能/配置在目录被信任前保持休眠；决策按路径持久化到用户目录；`--trust` / `--no-trust` 一次性覆盖
- **Eval 框架一期（P#46）**：Experiment → Cells → Attempts → Results 数据模型，用固定任务集度量 harness 变更
- **上下文修剪 + 惰性归档（MK#43）**：超大的旧工具结果每次会话启动修剪一次，可经 `archive_read` 逐字取回
- **压缩覆盖摘要（MK#42）**：摘要戳明它替换了什么
- **用户级记忆 + 后台任务 + 记忆整理**：`remember` 支持 `scope: project|user`；`/bg <prompt>` 派发隔离后台轮次；`aih tidy` / `aih distill` 去重记忆并挖掘重复流程
- **BM25 技能相关性 + 流式 TPS**：已装技能按用户查询排序并自动浮现；逐请求流式吞吐显示在 `/usage`、`aih stats` 与 TUI 上下文面板
- **技能驱动的钩子配置（D#11）**：技能 front matter 可声明 `secretPatterns`，内置脱敏钩子额外屏蔽
- **Agent Teams（最小）（D#15）**：`aih team` 管理名册、任务板、每代理邮箱
- **`/find` 工具输出检索（T#22）**：跨所有工具输出检索，命中展开并滚动到首个命中

**修复**

- **上下文面板真实性**：免费网关报告的累计/垃圾 `prompt_tokens` 不再进入显示——用量样本窗口化、压缩作为硬溯源边界、过期样本回退本地估算
- **CJK 感知的 token 估算**：扁平 chars÷4 对中文+JSON 会话少估约 3×，已修正

## 0.2.0

**新增**

- **Codex 风格加固**：子进程 env 策略剔除密钥类变量（`KEY`/`TOKEN`/`SECRET`/`PASSWORD`、`AIH_*API*`）；`--debug-prompt` 打印每次 LLM 调用的模型可见消息；技能名册在 ~2% 上下文预算内注入系统提示
- **多模型目录**：provider 可声明 `models[]`；`ctrl-p` 与 `/model` 运行时切换已验证模型
- **实时上下文窗口探测 + 主动/被动/手动压缩**：保留逐字最近尾部 + 滚动摘要（`compactNow()`、`/compact`）；用户查询不变量保证压缩后严格聊天模板仍可用
- **TUI 设计走查**（拆分/统一布局、粘贴修复）与更丰富的会话内省

## 0.1.0

**新增**

- 初始 harness：`AgentLoop` 步引擎（max-steps 交接预填）、`SessionLog` append-only JSONL 持久化 + 分叉/回放、`ToolRegistry`、`PolicyGate` / `RulesetGate` 审批流、路径作用域写审批、plan/只读模式
- MCP server 暴露应用 context/actions；CLI 入口（`run` / `chat` / `tools` / `describe` / `sessions`）、内置 todo-app 示例、OpenAI 兼容适配器（SSE 流式 + 429/5xx 重试）
- 契约文档（`APP.md`、`harness.yml`）与门禁：`doctor`、`check`、冒烟测试、完整 `eval`
