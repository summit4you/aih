---
title: How to read this book
description: "AIH: A Learner's Guide & Source Deep-Dive — five parts, eighteen chapters, from install to kernel, mechanisms to ecosystem, practice to design philosophy. Modeled on opencodebook.xyz."
---

# How to read this book

This is both a **beginner tutorial** and a **chapter-by-chapter source-code deep-dive**
into **AIH (App Intelligence Harness)**. The structure borrows from
[opencodebook.xyz](https://www.opencodebook.xyz/) — a book that dissects OpenCode across
*five parts and eighteen chapters*. We fit the same skeleton over AIH, grounding every
chapter in AIH's real code, mechanisms, and design decisions.

> Prerequisites are light. Part I is entirely newcomer-friendly. Before Part II, we
> suggest you follow the [Quick start](../quickstart) and run AIH once yourself
> (`aih` or `aih run ... --mock`). Source references are given as repo-relative paths,
> so you can open the matching file at any time.

## How the book is divided

| Part | Chapters | Core topics |
|---|---|---|
| **I · Foundations** | 1–3 | Background, environment, overall architecture |
| **II · Core Architecture** | 4–8 | Session, tool, agent, provider, MCP |
| **III · Key Mechanisms** | 9–12 | Permissions, snapshots, event stream, CLI/TUI |
| **IV · Ecosystem** | 13–16 | Extensions, skills, community, IDE/headless |
| **V · Practice** | 17–18 | End-to-end hands-on + design philosophy |

## Minimal reading paths

- **Just want to use it**: [Ch.1](ch01) → [Ch.2](ch02) → [Ch.17](ch17).
- **Platform integration**: [Ch.3](ch03) → [Ch.8](ch08) → [Ch.17](ch17).
- **Security / permissions**: jump to [Ch.9](ch09) and [Ch.18](ch18).
- **Hacking on the source**: [Ch.2](ch02) + [Ch.4–7](ch04) + [Ch.13–14](ch13).

## A note on source references

AIH is a TypeScript monorepo: the kernel lives in `core/src/`, the CLI in `cli/src/`,
and the integration layer in `mcp-server/src/`. The deep-dive chapters anchor on **real
file paths + key identifiers** and explain the *why* behind each mechanism rather than
listing every line. Wherever possible each concept earns a runnable or verifiable landing
point.

## Table of contents

- Part I · Foundations
  - [Ch.1 · From coding assistants to the AIH positioning](ch01)
  - [Ch.2 · Project structure & development environment](ch02)
  - [Ch.3 · Overall architecture design](ch03)
- Part II · Core Architecture
  - [Ch.4 · The session system](ch04)
  - [Ch.5 · The tool system](ch05)
  - [Ch.6 · The agent system](ch06)
  - [Ch.7 · The provider layer](ch07)
  - [Ch.8 · MCP & integration shapes](ch08)
- Part III · Key Mechanisms
  - [Ch.9 · The permission control system](ch09)
  - [Ch.10 · Snapshots & the file system](ch10)
  - [Ch.11 · Event stream & scheduling](ch11)
  - [Ch.12 · CLI & TUI](ch12)
- Part IV · Ecosystem
  - [Ch.13 · Plugin & extension system](ch13)
  - [Ch.14 · The skill system](ch14)
  - [Ch.15 · Community & reusable skills](ch15)
  - [Ch.16 · IDE & headless access](ch16)
- Part V · Practice
  - [Ch.17 · Hands-on: integrate an app end-to-end](ch17)
  - [Ch.18 · Design philosophy & best practices](ch18)

Ready? Start with [Ch.1](ch01).
