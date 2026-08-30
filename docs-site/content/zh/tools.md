---
title: 工具
description: AIH 工具体系 —— 外接应用工具 + 内置通用工具、并行只读、沙箱 seam。
---

# 工具

AIH 的 agent 内核是**通用**的：工具来自外接应用（AppAdapter 的 Action），交互终端
默认再挂一套本地通用工具（与任意 MCP 应用工具并存，**同名时应用工具优先**）。

## 内置通用工具

| 工具 | 说明 | 权限 |
|---|---|---|
| `list_dir` / `read_file` | 列目录 / 读文件（64KB 截断、行偏移） | allow |
| `write_file` / `run_cmd` | 写文件 / 执行命令（默认 120s 超时，可传 `timeout_ms` 至 600s；后台子进程不阻塞） | ask |
| `edit` | 精确字符串替换编辑（歧义时报错，`replace_all` 全替换） | ask |
| `glob` / `grep` | 按模式找文件 / 正则搜内容 | allow |
| `webfetch` / `websearch` | 抓 URL（浏览器级 UA、有界重试、Cloudflare 自愈、`timeout` 参数、可操作报错）/ 网页搜索 | allow |
| `todo` | 会话任务清单（状态戳进 tool-result，随分支回退） | allow |
| `remember` | 持久化知识到 memory.md（project / user 两级） | allow |
| `load_skill` | 加载技能全文（去重，二次调用返回摘要） | allow |
| `task` | 串行子代理（独立上下文、有界步数） | allow |
| `best_of_n` | 并行子代理 + 裁判（Max Mode）；多策略 `prompts`（FB#1）+ 可选双裁判面板 `AIH_SECOND_JUDGE_MODEL`（FB#2） | allow |
| `question` | 向用户提问并等待回答（交互式） | allow |

## 并行只读工具

单步内**连续只读**工具调用并发执行，上限 `AIH_TOOL_CONCURRENCY`（默认 4）；
**写类恒串行**；结果按原序落盘。读/写/读交错时写仍串行。

## 沙箱 seam

`run_cmd` 的执行后端可替换（`cli/src/sandbox.ts` 的 `SandboxBackend` 接口）：

| 后端 | 说明 |
|---|---|
| `local`（默认） | 直接在本机执行 |
| `bwrap` | bubblewrap 沙箱 |
| `remote` | 远程执行 |

用 `AIH_SANDBOX` 或工具参数 `sandbox` 选择。先定接口，默认本地。

## 工具结果

- **修剪 + 惰性归档**：超长结果修剪，全量落盘 `.aih/outputs/*.log`，`archive_read` 按需读回
- **脱敏 + 计时钩子**：默认开启的内置钩子在工具结果上做脱敏与计时
- **T1/T2 边界事实**：`commitToolPrepared` / `commitToolOutcome` 记录工具边界，崩溃恢复可判定

## 技能层

技能是可复用的指令包（YAML frontmatter + 正文），让 agent "接入即懂行"：

```sh
npm run cli -- skills list                        # 列出：project > user > builtin 三级
npm run cli -- skills find tour                   # 按关键词检索
npm run cli -- skills install app-tour            # 把内置技能落盘到 .aih/skills/
npm run cli -- skills show app-tour               # 查看正文
```

内置技能：`app-tour`（能力巡览）、`batch-ops`（批量操作 plan-execute-verify）、
`session-report`（会话报告）。同名时项目覆盖用户覆盖内置。

**相关性自动加载**：每轮开始前用 BM25 对已装技能做相关性排序（CJK 按字符 bigram
分词），命中技能以"建议加载"提示注入本轮上下文，模型可直接 `load_skill`；
`aih skills suggest <query>` 可离线查看同一排序。

## 权限

工具行为由权限控制（`allow` / `ask` / `deny`），详见 [权限](permissions)。

## 下一步

- 权限模型 → [权限](permissions)
- 会话与审计 → [会话](sessions)
- 配置工具并发 → [配置](config)
