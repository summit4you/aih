---
title: 编程智能体
description: aih --dev 编程智能体 —— 本地通用工具集（文件/命令/搜索/网页）、chat 与 run 的差异、对齐 opencode 内置工具。
---

# 编程智能体

AIH 的 agent 内核是**通用**的：工具来自外接应用，交互终端默认再挂一套**本地通用工具**
（对齐 opencode 的内置工具集），于是它本身就是一个能读文件、跑命令、改代码、查资料的
**编程智能体**。`--dev` 控制这套工具集的开关。

## 工具集（对齐 opencode 内置工具）

| 工具 | 说明 | 权限 |
|---|---|---|
| `list_dir` / `read_file` | 列目录 / 读文件（64KB 截断、行偏移） | allow |
| `write_file` / `run_cmd` | 写文件 / 执行命令（默认 120s 超时，`timeout_ms` 至 600s；后台子进程不阻塞） | ask |
| `edit` | 精确字符串替换编辑（歧义时报错，`replace_all` 全替换） | ask |
| `glob` / `grep` | 按模式找文件 / 正则搜内容 | allow |
| `webfetch` / `websearch` | 抓 URL / 网页搜索 | allow |
| `todo` | 会话任务清单（状态戳进 tool-result，随分支回退） | allow |
| `remember` | 持久化知识到 memory.md（project / user 两级） | allow |
| `question` | 向用户提问并等待回答（交互式） | allow |
| `task` / `best_of_n` | 串行子代理 / 并行子代理 + 裁判（Max Mode） | ask |
| `apply_patch` | 多文件补丁 | ask |
| `load_skill` | 加载技能全文 | allow |
| `archive_read` | 读回被修剪归档的工具输出 | allow |

这些工具与任意 MCP 应用工具**并存**，**同名时应用工具优先**。

## chat 与 run 的差异

| 形态 | 本地工具集 | 说明 |
|---|---|---|
| `aih chat`（交互） | **默认开启**（`--no-dev` 关闭） | 交互终端就是编程智能体 |
| `aih run "<msg>"` | **默认关闭**（`--dev` 开启） | 一次性问答默认只碰应用工具，显式 `--dev` 才挂本地工具 |

> 设计意图：`run` 常用于脚本/管道，默认最小面；`chat` 是交互场景，默认给全套。

## 典型用法

```sh
# 交互：直接当编程智能体用（默认带本地工具）
aih

# 一次性：显式挂载本地工具集
aih run "在 src 里找出所有 TODO 注释并汇总" --dev

# 只读分析（plan 模式 + auto：只读命令自动放行）
aih run "review 一下这个 diff 的风险" --dev

# 跑测试并修
aih run "跑 npm test，红了就修" --dev -y
```

## 与外接应用工具的关系

- **应用工具**（AppAdapter 的 Action）：你的业务动作（如 `create_order`）
- **本地工具**（`--dev`）：通用编程能力（文件/命令/搜索/网页）
- 两者在同一 `ToolRegistry` 里并存，权限各自独立，审计统一

## 安全默认

- 写类工具（`write_file` / `run_cmd` / `edit` / `apply_patch`）默认 `ask`
- `run_cmd` 子进程 env 密钥过滤（`KEY`/`TOKEN`/`SECRET`/`PASSWORD` 类变量被剔除）
- 脱敏钩子默认开启（工具结果里的密钥形态被抹掉）
- 沙箱 seam：`run_cmd` 可切 `local` / `bwrap` / `remote` 后端
