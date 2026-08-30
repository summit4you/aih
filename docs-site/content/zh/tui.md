---
title: 交互终端
description: opencode 风格全屏 TUI —— 渲染、权限确认、多行输入、斜杠命令、快捷键。
---

# 交互终端

AIH 的交互终端是 opencode / MiMo-Code 风格的全屏 TUI。

## 渲染

- **轻 Markdown**：标题→粗体、代码块→暗色 + **语法高亮**（关键字/字符串/数字/注释分色）、
  引用→暗色、列表→`•`/序号、行内代码→青色、行内链接双色下划线、表格 `|`→`·`
- **工具图标**行内：`$` bash / `→` read / `✱` search / `%` web / `←` write / `#` todo / `⚙` 其他
- **同类工具自动分组折叠**（`$ bash ×3 click to expand`）
- `run_cmd` 等结果**前三行预览**（`… N more · click to expand`）

## 输入

- **多行输入框**：按显示宽度折行（CJK 宽字符感知、光标精确定位）、框内滚动
- `/` 触发 **Tab 幽灵补全**
- 忙碌时旋转指示器 + 已用秒数
- 上下键翻输入历史

## 权限确认（文件夹级记忆）

```
⚠ approval requested: run_cmd { "command": "rm -rf build" }
  [y] once · [n] no · [a] always <scope>
```

- `scope` 由目标路径自动推导为父目录
- 选 `a`（always）按 **last-match-wins** 持久化到 aih.json
- 忙碌中提交自动排队（`queued: …`）

## 底部

- 重边线（滚动时 `↑N`）+ 提示行（cwd · 快捷键 · 右侧上下文用量 `used/limit (pct%)`）
- 状态行（`⊙ N MCP` 徽章 · 应用 · 版本 · 会话名）

## 交互与快捷键

| 操作 | 效果 |
|---|---|
| 鼠标滚轮 / PgUp / PgDn | 滚动 |
| 上下键 | 翻输入历史 |
| `exit`（或 `/quit`） | 还原终端退出 |
| 忙碌中 `ctrl-c` | 取消当前轮（不退出） |
| 空闲 `ctrl-c` | 清空输入，再按退出 |
| `ctrl-p` | 打开模型选择器 |
| `tab` | 斜杠命令补全 |
| `?` | 帮助 |

## 会话标题

首轮后自动 LLM 生成 2–6 词标题（`<name>.jsonl.meta.json`），状态栏与 `session list` 显示。

## /vivid 简洁渲染

切换 plain 模式——去掉边框/底色/侧栏/状态提示等 chrome，只留正文（适合低带宽/远程/日志
回放）；再按一次还原完整主题。

## /find 检索

跨所有工具输出逐行检索（含 32KB 内带上限的展开内容），命中工具自动展开并滚动到首个命中，
列出最近 12 条命中（`tool · line · 片段`）。超出内带上限的全量输出用
`run_cmd keep_output=true` 落盘 `.aih/outputs/*.log`。

## Intelligent Terminal（IT#1–IT#5）

- **`/sessions`（IT#4）**——会话管理面板：列出活跃 + 已存 agent 会话，含状态、token 用量与成本。`/sessions kill <id>` 取消运行中任务；`/sessions view <name>` 查看单会话摘要。
- **`/shell`（IT#1）**——打印最近 shell 上下文（最近命令、退出码、cwd、输出尾部）。设 `AIH_SHELL_CONTEXT=auto` 时每轮自动注入该上下文。
- **`/fix`（IT#2）**——确定性（无 LLM）失败检测在 `run_cmd` 出错时点亮红色 `⚠ N failed` 徽标；`/fix` 把失败上下文发给 agent 生成修复建议。
- **`?` 前缀（IT#3）**——TUI 输入行以 `?` 开头即起一个 agent 任务，并自动注入当前 shell 上下文（快速询问最近 shell 的便捷方式）。
- **run-or-copy 批准（IT#5）**——写类 `run_cmd` 批准为显式 `[R]un / [C]opy / [N]o`（无剪贴板时 copy 退化为打印命令）；绝不自动执行。
