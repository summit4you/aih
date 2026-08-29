---
title: 权限
description: allow / ask / deny 三级权限、pattern/路径作用域、doom_loop、autoAllowReadonly、密钥作用域。
---

# 权限

AIH 用 **allow / ask / deny** 三级权限控制每个工具/动作的行为，读操作默认放行，
写操作默认需确认，业务红线直接拒绝。

## 三级权限

| 档位 | 默认对象 | 行为 |
|---|---|---|
| `allow` | 读操作 | 直接执行 |
| `ask` | 写操作 | 经 `ApprovalGate` 人工/策略确认 |
| `deny` | 业务红线 | 注册表直接拒绝 |

策略实现 `ApprovalGate` 即可接入自有审批系统（`PolicyGate` 提供规则引擎雏形）。

## TUI 内联确认

```
⚠ approval requested: run_cmd { "command": "rm -rf build" }
  [y] once · [n] no · [a] always <scope>
```

- `scope` 由目标路径自动推导为父目录
- 选 `a`（always）按 **last-match-wins** 持久化到 aih.json（项目 > 全局）
- 忙碌中提交自动排队（`queued: …`）

## 配置权限规则

在 `aih.json` 中用 pattern / 路径作用域声明（last-match-wins）：

```json
{
  "permissions": {
    "edit": "allow",
    "run_cmd": "ask",
    "write_file:src/**": "allow",
    "write_file:secrets/**": "deny"
  }
}
```

- 支持通配符同时控制多个工具（如 `mymcp_*: "ask"`）
- 路径作用域让"某目录下的写操作"可单独放行/拒绝
- 文件夹级权限：`v1` 已交付（opencode pattern Ruleset）

## doom_loop 守卫

opencode 权限基线 `doom_loop: ask`：检测 agent 反复执行相同失败操作（死循环），
触发时降级为 `ask` 需人工确认，防止烧 token。

## autoAllowReadonly（auto mode）

`plan` 模式 + auto 时，**只读**命令（如 `git status`、`ls`、只读 `run_cmd`）自动放行，
不再逐条询问——只读分类是确定性本地判定（无 ML），写操作仍走 `ask`。

## 密钥作用域（运行时出口校验）

- **子进程 env 密钥过滤**：`run_cmd` 子进程剔除 `KEY`/`TOKEN`/`SECRET`/`PASSWORD` 类
  变量与 `AIH_*API*`，防密钥泄漏到子进程环境（`cli/src/env-policy.ts`）
- **密钥仅发往其属主端点**：运行时出口校验，telemetry 等请求不会携带不属于该端点的密钥
- **项目信任门**：`project-trust.ts` + `trust.json`，未信任项目的扩展/钩子受约束

## 注入源审批隔离

来自工具结果/外部内容的指令（注入源）不享受与用户指令相同的审批待遇——
防止"工具输出里夹带的指令"绕过 `ask` 直接执行。

## 下一步

- 接入应用时标注权限 → [接入你的应用](adapter)
- 工具清单 → [工具](tools)
- 会话审计 → [会话](sessions)
