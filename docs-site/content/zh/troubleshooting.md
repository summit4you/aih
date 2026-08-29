---
title: 故障排查
description: 常见问题与排查 —— 安装、连接、权限、会话、性能。
---

# 故障排查

## 安装与运行

**`node: command not found` / 版本过低**

AIH 需要 Node.js ≥ 20。`node -v` 确认版本；用 `nvm` 或包管理器升级后重试。

**`npm run cli` 报模块找不到**

先构建：

```sh
npm run bootstrap && npm run build
```

**安装脚本失败**

```sh
curl -fsSL https://raw.githubusercontent.com/summit4you/aih/main/scripts/install | bash
```

加 `--dir <path>` 换目录、`--no-modify-path` 不碰 PATH；Windows 用 PowerShell 的 `irm | iex` 变体。

## 连接与模型

**`401 / 403`（鉴权失败）**

- 确认 `AIH_API_KEY`（或 provider 的 `apiKeyEnv`）已设置且有效
- 确认 `AIH_BASE_URL` 指向正确的 OpenAI 兼容端点
- `aih config` 打印生效配置与各字段来源，核对 provider / baseUrl / model

**`429`（限流）/ 5xx**

LLM 对 429/5xx 自动重试；持续失败时换一个 provider 或模型（`/model` 热切换、`aih models` 查看可用）。

**连接超时 / 无响应**

- 检查网络与代理；`AIH_BASE_URL` 是否可达
- 流式（SSE）端点需支持 `stream: true`

## 权限

**写操作被拒绝 / 一直要求确认**

- 非 TTY 下写操作须显式 `--yes`，否则拒绝执行
- `ask` 是默认档位；在 `aih.json` 的 `permissions` 里按 pattern/路径调整（last-match-wins）
- 选 `a`（always）按文件夹级持久化，避免重复询问
- `denied by registry` 表示命中 `deny` 红线——这是预期行为，需改配置或业务逻辑

**doom_loop 触发**

agent 反复执行相同失败操作会被降级为 `ask` 需人工确认——这是防烧 token 的守卫，检查工具调用参数是否陷入死循环。

## 会话

**上下文丢失 / 未续上**

- 确认未用 `--ephemeral`（该 flag 关闭持久化）
- 会话默认存 `.aih/sessions/default.jsonl`；`--session <name>` 指定名称，`-c` 续跑最近会话
- `aih session list` / `show` 查看；`aih stats` 看 token 用量

**回滚后状态不对**

回滚是"前缀分叉"，原文件不动；有状态工具（如 `todo`）从恢复前缀回收最新快照回写。确认 `/restore [seq]` 的 seq 正确。

## 性能

**响应慢**

- 长会话先 `/compact` 压缩上下文
- 只读分析用 `plan` 模式（只读命令自动放行，少确认往返）
- `run_cmd` 默认 120s 超时，长任务传 `timeout_ms`（至 600s）或后台化

**输出被截断**

工具结果超长按"修剪 + 惰性归档"处理，全量落盘 `.aih/outputs/*.log`，用 `archive_read` 按需读回；`run_cmd keep_output=true` 可强制保留全量。

## 获取帮助

- `aih doctor` —— 环境与就绪检查
- `aih config` —— 生效配置与来源
- `aih --help` / 各子命令 `--help`
- 仓库 Issue：[github.com/summit4you/aih](https://github.com/summit4you/aih)
