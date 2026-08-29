---
title: 安装
description: 安装 AIH —— 一行脚本、包管理器或从源码构建。
---

# 安装

## 前提条件

- **Node.js ≥ 20**（构建与运行均需要）
- 一款现代终端模拟器（交互 TUI 场景）
- 你想使用的 LLM 提供商的 API 密钥（可选，`--mock` 离线演示无需密钥）

## 一行脚本安装（推荐）

**macOS / Linux / WSL**：

```sh
curl -fsSL https://raw.githubusercontent.com/summit4you/aih/main/scripts/install | bash
```

**Windows PowerShell**：

```powershell
irm https://raw.githubusercontent.com/summit4you/aih/main/scripts/install.ps1 | iex
```

**选项**：`--version <ver>`（指定版本）、`--dir <path>`（自定义目录）、
`--no-modify-path`（不修改 PATH）。

## 从源码安装（开发者）

```sh
git clone https://github.com/summit4you/aih && cd aih
npm run bootstrap   # 安装依赖
npm run doctor      # 就绪检查
npm run check       # 构建 + 契约一致性校验
npm test            # 冒烟测试（core / mcp / cli）
npm run eval        # 完整交接门禁（doctor + bootstrap + check + test）
```

## 验证安装

```sh
# 离线演示（无需 API key）
npm run cli -- run "add a todo buy milk" --mock

# 真实模型（任意 OpenAI 兼容接口，支持 SSE 流式输出）
AIH_BASE_URL=https://api.deepseek.com/v1 \
AIH_MODEL=deepseek-chat \
AIH_API_KEY=sk-... npm run cli -- run "今天有哪些待办？"
```

## 直接运行交互终端

```sh
# 进入 opencode 风格 TUI（需 TTY）
aih
```

## 离线安装包

仓库提供 `dist-offline/` 离线包，适合无网络环境：把 `node_modules` 一并打包后
`npm ci --offline` 即可。
