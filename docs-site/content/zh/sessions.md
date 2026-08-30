---
title: 会话
description: 会话持久化与审计 —— append-only JSONL、分叉/树结构、checkpoint 回滚、分支蒸馏、压缩。
---

# 会话

AIH 的会话是 **append-only JSONL**（每行一个 `SessionEvent`），"模型可见即可回放"。
`chat` 与 `run` 默认把会话持久化到 `.aih/sessions/default.jsonl`（退出即落盘，含
Ctrl-C/exit 中断场景），再次进入自动续上并**回放历史**（用户/助手消息、工具调用与
结果、压缩事件按原序渲染，上下文完整还原）。

## 持久化与续跑

```sh
npm run cli -- chat                                # 默认持久化到 default，下次自动恢复
npm run cli -- run "添加待办A" --session work     # 指定会话名 → .aih/sessions/work.jsonl
npm run cli -- run "再添加B" -c                   # 续跑最近会话（上下文完整保留）
npm run cli -- run "..." --ephemeral              # 关闭持久化
```

## 会话管理

```sh
npm run cli -- session list                       # 列出
npm run cli -- session show work                  # 人类可读回放
npm run cli -- session export work > work.json    # 导出为 JSON
npm run cli -- session rm work                    # 删除单个（路径穿越安全）
npm run cli -- session rm --all                   # 清空全部已存会话
npm run cli -- stats                              # 所有会话 token 用量汇总
```

- **`/sessions` TUI 面板（IT#4）**：交互式会话管理面——列出活跃 + 已存会话，含状态、token 用量与成本；`/sessions kill <id>` 取消运行中任务，`/sessions view <name>` 查看单会话摘要。

## 分叉与树结构

```sh
npm run cli -- session fork default branch-a --from 7   # 从事件序 7 分叉出新会话
```

- 每条事件可选 `parentId`（缺省=前一条，旧文件零迁移）
- `SessionLog.tree()` / `branchPoints()`，TUI `/tree` 分支视图
- **分支蒸馏**：`session distill-branch <废弃> <目标> --from 7` 把废弃分支蒸馏为
  `branch_summary` 注入目标会话

## 检查点与回滚

```sh
npm run cli -- session checkpoint work "before risky refactor"   # 记录检查点
npm run cli -- session restore work                              # 回滚：前缀分叉为 work-restore-<seq>（原文件不动）
# TUI 内：/checkpoint [note] 与 /restore [seq]（回滚前自动快照完整历史）
```

- **append-only**：回滚不删除原文件，而是把前缀分叉为新会话
- 有状态工具把完整状态戳进 tool-result details（如 `todo` 工具
  `details: { kind: "state.todos", todos }`），`/restore` 时从恢复前缀回收最新快照回写
  `.aih/todos.json`——**状态随分支自然回退**

## 上下文压缩

- **主动 + 被动 + 手动**：`/compact [focus]`
- **投影式 checkpoint**：compaction 事件带 `coverage { upToSeq, eventCount, digest }`，
  `deriveMessages` 只接受 digest 匹配的摘要（会话文件被外部改动时拒绝投影并告警，
  fail-open 到原始尾部）
- **滚动摘要**：摘要器输入 = 上次摘要 + 新被逐出的事件，不重摘全世界
- **工具结果修剪 + 惰性归档**：超长结果修剪，全量落盘 `.aih/outputs/*.log`，
  `archive_read` 按需读回

## 审计

每次工具调用另追加到 `.aih/tool-audit.jsonl`（ts/tool/args[4KB]/ok/error），含 `task`
子代理内部调用；`--no-audit` 关闭。

## 会话标题

首轮后自动 LLM 生成 2–6 词标题（`<name>.jsonl.meta.json`），状态栏与 `session list`
显示。

## 下一步

- 权限模型 → [权限](permissions)
- 工具体系 → [工具](tools)
- 配置 → [配置](config)
