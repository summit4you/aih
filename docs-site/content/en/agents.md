---
title: Agents
description: The subagent system — task serial subagents, best_of_n parallel judge (Max Mode), Agent Teams, named agent profiles.
---

# Agents

AIH extends "one model + one session" into "a group of orchestratable agents," covering single-point delegation to team collaboration.

## task: serial subagent

Delegate a self-contained subtask to a **focused subagent** (independent context, up to 8 steps, no further nesting):

- suits research or multi-step isolated work, **without polluting the main conversation context**
- the subagent has its own tool view and step budget; when done it returns the result to the main agent
- the main agent keeps the full context and only receives the conclusion

```sh
# delegate directly in a session (the model calls the task tool)
"research three approaches to X and give a comparison"
```

## best_of_n: parallel subagents + judge (Max Mode)

Run N independent subagents in parallel on the same prompt (bounded concurrency, `AIH_TOOL_CONCURRENCY`), then a **judge** picks the best answer:

- suits high-stakes answers where one shot isn't reliable enough
- N defaults to 3, capped at 8
- the judge is independent of the candidates, avoiding "grading yourself"

## Agent Teams (roster + task board + mailbox)

Multi-agent collaboration: roster + task board + mailbox (D#15):

```sh
aih team list                          # roster
aih team add-agent <name> <role>       # add a member
aih team add-task <title> <assignee>   # assign a task
aih team claim <task>                  # claim
aih team dispatch                      # dispatch
aih team mail <to> <body>              # send a message
aih team inbox                         # inbox
```

## Named agent profiles (E#18)

`-a, --as <name>` selects a **named agent profile** — its permission rules + optional prompt line take effect for this run (`aih agents` lists configured profiles):

```sh
aih run "refactor this" --as reviewer   # use reviewer's permissions + prompt
aih agents                              # list profiles
```

- a profile's permission rules override the base permissions; an unknown profile falls back to base permissions with a warning
- suits fixing reusable roles like "read-only review" or "strict write protection"

## Relationship to the Goal judge

- **Goal judge** (`/goal`) decides "is the goal met," preventing optimistic stopping
- **best_of_n judge** decides "which answer is better"
- both are independent LLMs, separate from the executing agent — judgment decoupled from execution
