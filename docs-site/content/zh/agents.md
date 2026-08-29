---
title: 智能体
description: 子代理体系 —— task 串行子代理、best_of_n 并行裁判（Max Mode）、Agent Teams、命名 agent profile。
---

# 智能体

AIH 把"一个模型 + 一个会话"扩展成"一组可编排的代理"，覆盖从单点委派到团队协作。

## task：串行子代理

把一个自包含的子任务交给一个**聚焦子代理**（独立上下文、最多 8 步、不可再嵌套）：

- 适合研究或多步骤的隔离工作，**不污染主对话上下文**
- 子代理拥有自己的工具视图与步骤预算，完成后把结果交回主代理
- 主代理继续持有完整上下文，只接收结论

```sh
# 在会话中直接委派（模型会调用 task 工具）
"调研一下 X 的三种方案并给出对比"
```

## best_of_n：并行子代理 + 裁判（Max Mode）

同一提示并行跑 N 个独立子代理（有界并发，`AIH_TOOL_CONCURRENCY`），再由一个**裁判**
挑出最佳答案：

- 适合高风险、一次不够稳的答案
- N 默认 3，上限 8
- 裁判独立于候选，避免"自己评自己"

## Agent Teams（roster + 任务板 + mailbox）

多代理协作：名册 + 任务板 + 邮箱（D#15）：

```sh
aih team list                          # 名册
aih team add-agent <name> <role>       # 加成员
aih team add-task <title> <assignee>   # 派任务
aih team claim <task>                  # 认领
aih team dispatch                      # 派发
aih team mail <to> <body>              # 发消息
aih team inbox                         # 收件箱
```

## 命名 agent profile（E#18）

`-a, --as <name>` 选择一个**命名 agent profile**——它的权限规则 + 可选提示行在本次运行
生效（`aih agents` 列出已配置 profile）：

```sh
aih run "重构这段" --as reviewer      # 用 reviewer 的权限+提示
aih agents                            # 列出 profile
```

- profile 的权限规则覆盖基础权限；未知 profile 回退基础权限并告警
- 适合把"只读审查""严格写保护"等角色固化复用

## 与 Goal 裁判的关系

- **Goal 裁判**（`/goal`）裁决"目标是否达成"，防乐观停止
- **best_of_n 裁判**裁决"哪个答案更好"
- 两者都是独立 LLM，与执行代理分离——判断与执行解耦
