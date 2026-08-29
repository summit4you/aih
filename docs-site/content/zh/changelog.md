---
title: 更新日志
description: AIH 版本更新日志 —— 0.3.0 / 0.2.0 / 0.1.0 的主要变更。
---

# 更新日志

完整逐条记录见仓库 [`CHANGELOG.md`](https://github.com/summit4you/aih/blob/main/CHANGELOG.md)（Keep a Changelog 格式，SemVer 版本）。本页为各版本要点摘要。

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
