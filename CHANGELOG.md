# Changelog

All notable changes to AIH are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/). The installer validates release tarballs against
the versions listed here (`scripts/package` derives the version from
`cli/src/index.ts` → `VERSION`).

## [Unreleased]

### Fixed
- **26 个字母中只有 `o`/`O` 在空输入框无法输入（根因：toggle 快捷键与字母冲突）**
  （`cli/src/tui.ts`，`3c0e3ef` 引入，`d23aed3`/`7c9596b` 曾多次打补丁未根治）：
  `o`/`O` 在空 composer 时被定义为「展开/折叠工具块」快捷键（conhost 无鼠标键盘
  路径）。只要 transcript 里有可 toggle 的块（**重启恢复会话后必有上一轮 tool 块**），
  空输入框打 `o` 就被吞掉改去 toggle——其余 25 个字母不受影响，因此表现为
  「只有 o 不行，打头之后 o 正常」。**根治**：删除 `o`/`O` toggle 快捷键（连同
  `#hasToggleable` 辅助），`o` 与所有字母一样走正常输入。空输入框 toggle 的唯一
  键是 **Enter**（本就存在，`\r` case）。同步更新 help 提示（`Enter/o =` → `Enter =`）。
  smoke 覆盖四种场景：空 transcript 首次 `o`、有 tool 块时空 composer `o`、CPR+key
  同 chunk、Enter 折叠/展开仍正常。
- **重启后首次输入 `o`/`O` 被吞（DSR probe chunk 丢弃竞态）**（`cli/src/tui.ts`，
  `cfd9c48` 引入）：`feedProbe` 匹配到 CPR 后整个 chunk `return true`，若终端把 CPR
  响应和首个按键合并成同一 stdin chunk，按键（如 `o`）被连带丢弃。修复：`feedProbe`
  剥掉 CPR 序列、保留 chunk 其余字节继续走正常输入路径（返回剩余串，空/null 区分）。
  真实路径复现（mock TTY + `start()` + 同 chunk `ESC[1;3Ro`）。smoke 走真实 stdin 路径。

### Added
- **歧义宽度终端自动探测（DSR probe）**（`cli/src/tui.ts`）：启动时（raw mode 下、
  首帧 paint 前）向终端写一个盒线字符 `─` 并用 DSR（`ESC[6n`）量回光标列，直接测出
  本终端把 EAW=A（歧义宽度）字符渲染成 1 格还是 2 格，据此校准 `width()` 模型。
  解决 tmux / CJK 字体下侧栏进度条与文字因宽度低估而回行、左 margin 偏大的问题——
  不再依赖 `AIH_AMBIGUOUS_WIDE` 环境变量（仍可用 `=1`/`=2` 强制覆盖）。终端 200ms 内
  不响应则回退窄默认；宽度模型翻转时失效 `clusterWidthCache` 以免旧值污染首帧。
  smoke 覆盖 DSR 列→宽度分类器。
- **自动更新（opencode `upgrade` parity）**（`cli/src/update.ts`）：
  检查 GitHub `releases/latest` → 与已装版本比较 → 有新版本时 TUI 顶部提示
  `✨ vN available — /update`（后台检查、失败静默、跳过版本被记住，只有更新的
  release 才再提醒，opencode `skipped_version` 语义）。`/update`（TUI）与
  `aih update [version]`（CLI）：先**下载到本地 staging**（`/tmp/aih-update-*`）再
  应用——解压、`aih --version` 验证、原子 swap（旧安装在新安装被证明可用前绝不删除）。
  只自动更新 tarball 安装布局（`<dir>/app/aih`）；dev checkout / npm 安装则打印
  官方安装命令（opencode `method=unknown` 语义）。`--check` 只报告、`--yes` 跳过确认
  （非 TTY 安全）。`AIH_DISABLE_UPDATE_CHECK=1` 关闭检查。smoke 覆盖版本比较、
  tarball 命名、skip-state 语义、install-dir 探测。
- **anti-amnesia：确定性 worktree 快照折叠进摘要**（`cli/src/compaction.ts`）：
  compact 时把确定性产物（git HEAD/worktree 状态、关键文件哈希、文件清单）折叠为
  幂等摘要片段，跨 compact 保持一致，agent 恢复时无需重读即可对齐真实工作区状态。
- **ANSI-Shadow 渐变启动 logo**（`cli/src/index.ts` + `cli/src/ui.ts` + `cli/src/tui.ts`）：
  手绘（比例失调）logo 替换为标准 figlet **ANSI Shadow** 字模（qwen-code /
  MiMo-Code 启动 logo 同款字体），A 顶部保留前导空格呈收窄居中形态；`gradientText()`
  零依赖 24-bit RGB 逐字符渐变（cyan → blue → magenta），TTY 才输出 SGR、非 TTY
  透传（SGR 隔离不破坏）。banner 行绕过 `#wrap` 的空格折叠——ascii art 空格有语义，
  `#wrap` 的 `split(/\s+/)` 会把多空格折成单空格导致字形错乱，现逐行原样输出仅 clip
  超宽。smoke 断言同步更新。
- **TUI 侧栏布局精修**（`cli/src/tui.ts`）：sidebar 42 → 34 列（右侧面板过宽），
  CONTEXT 用量进度条延伸到面板右缘（保持对称边距），恢复输入框/用户消息 `┃` 边框 +
  所有消息族右边距离开侧栏；面板对称边距 + diff 右缘对齐。
- **system 行语义色板（Q-R7，qwen-code terminal.ts parity）**（`cli/src/tui.ts`）：
  system 行从 dim/red 二态升级为语义色板——tool=蓝 `38;5;75`、permission=黄 `33`、
  model/memory=青 `36`、auth=绿 `32`、error=红 `31`、shell=灰 `38;5;244`、
  thought=dim `2`、info=默认 dim。`pushSystem(text, kind?)` 向后兼容（默认 info）；
  `pushError` 映射 error 红。gate.ts 全部权限裁决 + index.ts 的 model/auth 流已标注
  kind。映射表导出 `SYS_KIND_SGR` 供测试/复用。**工具行同步对齐**：`#toolRow` 与
  折叠组头（原青色 `accent`）的工具名统一改 `38;5;75` 蓝（与 qwen tool 行同色），
  失败仍红、参数仍 muted 灰。
- **overlay 栈（opencode DialogProvider parity）**（`cli/src/tui.ts`）：
  嵌套 picker（ctrl-p 命令面板 → 模型选择 → provider 连接）从"单槽、Esc 全关"
  改为**栈**——Esc 只弹出一级回到父级（不再需要二次 Esc 重进）；子级标题栏渲染
  `父级 › 当前` 面包屑、footer 提示 `esc back`（顶层仍 `esc close`）；
  `askQuestion` 打开前自动把整个 picker 链 cancel 掉（文本输入与 modal 互斥）。
  新增 `OverlayFrame` 导出类型 + `overlayTitle()` 测试钩子；smoke 覆盖嵌套/弹栈/面包屑全链路。
- **工具内容视觉分隔线**（`cli/src/tui.ts`）：有内容的工具行（output / diff / error /
  todos）在 header（蓝名 + 灰参）与内容区之间插入一条 `dim` 的 `───` 细线，形成
  header → 分隔 → 内容 三段式视觉块感；无内容的纯参数行不受影响。不加边框、不加
  背景，保持轻量方案。
- **消息块间距统一**（`cli/src/tui.ts`）：`transcriptLines()` / `#paint()` /
  `#contentLines()` 三处统一在每两个消息块之间插入 1 行空行（首个块除外），
  消除 user / system / tool / assistant 各 role 紧贴上一条消息的"粘连"观感。
  原先仅 assistant 有间距，现所有 role 一致。

### Fixed
- **diff 行换行而非截断**（`cli/src/tui.ts`）：diff 内容在宽度受限时按行 wrap 输出，
  不再把超宽行截断丢信息（opencode/mimo-code parity）。
- **Windows temp 目录授权只粘一次**（`cli/src/gate.ts`）：大小写/分隔符不敏感的路径
  匹配，临时目录授权一次后永久生效，不再每次重复弹确认。
- **MCP badge 计数错误**（`cli/src/tui.ts`）：statusBadge 统计了**全部**工具却标注
  "MCP"——现在只计数 MCP 后端工具。

## [0.8.0] - 2026-09-07

### Added
- **OC-R#1 网络失败弹性（turn 级 park-and-retry）**（`core/src/agent-loop.ts` +
  `core/src/seams/llm-sse.ts` + `core/src/seams/llm-openai.ts`）：
  - `NETWORK_FAILURE_RE` / `NETWORK_UNREACHABLE_RE` 规范网络失败分类 + `errFullText()`
    摊平 undici `err.cause`（"fetch failed" 掩盖真实 OS 码）；adapter 层网络类失败
    重试预算 ×3（同 capacity），不可达端点（ECONNREFUSED/ENOTFOUND）快速失败（首试即抛）。
  - AgentLoop 层：网络失败耗尽 adapter 预算后 park（`quota_wait` 事件 `reason:"network"`，
    默认 10s/20s，`AIH_NETWORK_PARK_MS` 可调）并**重发同一调用**，而非杀死 turn——
    修复「瞬时网络尖峰 = 整场对话结束」；死网络有界耗尽后仍诚实报错。
- **CL-R#5 — hook 故障隔离**（`core/src/tool-registry.ts` + `core/src/seams/permissions.ts`）：
  hook 抛普通 `Error` 视为基础设施故障——跳过该 hook、调用继续（不得当作否决），
  有意为之的策略否决改走 `HookVetoError`，扩展的 `cancel` 语义升级为该异常类型。
- **CL-R#7 — 凭据存储边界净化**（`cli/src/config.ts` `sanitizeCredential`）：
  API key 等凭据写入配置前剥离控制字符/零宽空格/BOM/首尾空白，纯空白视为未配置。
- **CC-R#6 — 技能可见性分层**（`cli/src/skills.ts`）：frontmatter `visibility:` 支持
  `full`（默认）/ `name-only`（仅列名字）/ `off`（不进名册但仍可按名加载）。
- **OMP-R#6 — edit 自动修复 + 受保护区**（`cli/src/general-tools.ts`）：
  edit 失败时先做空白归一化匹配兜底，命中后标记 `protectedRanges` 保证替换区域精确。
- **OMP-R#9 — prompt-cache 分桶统计**（`cli/src/index.ts`）：
  `turn/end` 用量拆分为 cache read / cache write / uncached input，进入 TUI
  Context 面板与 `/usage`；`P#41` prompt-cache 命中率。
- **OMP-R#11 — 可逆 secret 占位符**（`cli/src/secrets-placeholder.ts`）：
  模型回显已知 secret 时以 `{{secret:N}}` 占位（TUI 显示安全侧），工具执行前还原
  真实值（功能侧），补足 `redactCredential` 单向遮蔽。
- **KL-R#4 — 只读 shell 防御性否决（readOnlyBash）**（`core/src/seams/permissions.ts`）：
  只读 bash 上下文检测重定向/管道/后台/`$()` 等写向模式并否决；受保护写工具
  （shell + app write）在无显式规则时 floor 到 ask，显式 allow 须同时匹配路径与工具名。
- **PI-R#2 — 分支蒸馏**（`cli/src/worktree.ts` `checkRestoreSafety` + `cli/src/index.ts`）：
  checkpoint 恢复前检查回滚安全性（HEAD 前进/丢弃提交计数），被丢弃分支有实质会话
  内容时自动快照并提示 `aih session distill-branch`。
- **Doom-loop 升级观测器**（`core/src/observers.ts` `createDoomLoopEscalationObserver`）：
  连续 doom-loop 否决达到阈值（默认 3）即中止本轮（`observer_aborted`），任何其他
  结果重置计数——修复「同一调用被拒 86 次、零 assistant 文本、轮次永不停止」。
- **FA#4 — 重复调用止损观测器接线**（`cli/src/index.ts`）：`RepetitionObserver`
  软提示/硬停与 doom-loop 升级观测器接入交互轮与无头轮，提示以 TUI system 行呈现。
- **AbortSignal 支持**（`cli/src/dev-tools.ts` `RunShellInput.signal` +
  `core/src/types.ts` `ToolContext.signal`）：run_cmd 子进程支持外部取消，
  abort 时立即 kill 子进程（为 background-hook 等场景铺路）。

### Fixed
- **Windows conpty 残留转义误触 double-Esc**（`cli/src/tui.ts`）：运行 PowerShell
  子进程退出后 conpty 可能冲刷残留转义字节（截断的 bracketed-paste 标记、消耗过的
  CSI 后的孤立 `\x1b`），此前被误读为用户 double-Esc → 运行中轮次被自动取消。
  新增 `#lastSeqAt` + `ESC_NOISE_MS=150`：double-Esc 只在距上次已消费转义序列
  ≥150ms 后生效，残留字节不再进入作曲器/转录。

### 测试
- `core/src/smoke.ts`：doom-loop 升级（阈值/重置/端到端轮次中止）、hook 故障隔离
  （崩溃跳过 vs `HookVetoError` 否决）、before-hook ask floor（CC#53）。
- `cli/src/smoke.ts`：conpty 残留转义（不取消轮次/不进作曲器/不泄漏 `[20~`、
  真实 double-Esc 仍生效）。

## [0.7.2] - 2026-09-06

### Added
- **OMP-R#2 — `read_file` 双预算 + 四态截断**（`cli/src/dev-tools.ts` `truncateReadLines`）：
  读文件改「读全量 → 行预算切片（`offset_line`/`max_lines`）→ 字符预算投影」，
  双预算 3000 行 / 50KB + 逐行 512 字符；`full`/`head`/`tail`/`middle` 四态——
  `middle` 保 head 起始 + tail 结尾（verdict 行）+ `… N lines elided …` 标记，
  巨型行只留字节窗口（`tail_windowed_bytes`）不物化全串，首行超限发
  `first_line_exceeds_limit` 信号；返回 `state`/`lines_shown`/`lines_elided`/
  `total_lines_in_file`。
- **M-R#1 — compaction 文件改动清单（file manifest）**（`core/src/agent-loop.ts`
  `buildFileManifest`/`renderFileManifest` + `core/src/types.ts` `FileManifestEntry`）：
  压缩时从 read/patch 工具事件重建被触碰文件清单（`edited`/`written`/`read: full`/
  `read: lines x-y`，同路径按最后触碰去重），作摘要附加输入注入，减少压缩后
  重读/重改；全量落 `compaction` 事件 `fileManifest` 字段（可审计），渲染层封顶
  `MAX_FILE_MANIFEST_ENTRIES`(120) 条 + 溢出 `… N more`。
- **KL-R#4 — 只读 bash 护栏 + guarded 写工具**（`cli/src/readonly-allow.ts`
  `hasDefensiveVeto` + `core/src/seams/permissions.ts` `GUARDED_WRITE_TOOLS`）：
  ① 防御性黑名单在只读判定**之前**否决借只读外壳的注入命令（`;`/`&&`/`|`/`>`/
  反引号/`$(`/`sudo`/`eval`/`rg --pre`/`man -P`/`sh -c`/`rm`/`curl` 等），阻断
  `ls; rm -rf`、`grep … | sh` 一类任意执行路径；② guarded 写工具（`run_cmd`/
  `write_file`/`edit`/`apply_patch`/`append_text`/`patch`/`permissions`/
  `toggle_todo`/`remove_todo`/`add_todo`）的 `allow` 规则被降为 `ask`（`deny` 仍
  优先）——配置规则（含 allow-everything/机器写配置）永远无法自动放行它们，
  人工确认是不可被配置绕过的人类地板。

### Changed
- `core/src/smoke.ts`：path-scoped 兄弟写工具断言对齐 KL-R#4 guarded 语义
  （`write_file` 由 `allow` 降为 `ask`），新增 non-guarded 写工具仍 `allow` 的对照断言。

### Fixed
- **TUI 显示修复**（对齐 opencode / mimo-code，参考 agent-cli 审查后确认无适用组件）：
  - **Linux 输入框光标偏移**：v0.7.1 输入框改 `┃`+2 空格留白后光标 CUP 常数未同步
    （`curCol` 4→5），光标落在最后一个已输入字符上而非下一输入位——已修正并注释。
  - **上下文进度条**：modern 终端恢复 `█░` 块字符（`Tui.bar(pct,width,legacy)` 纯函数，
    legacy conhost GBK 代码页仍回退 `#`/`-`），smoke 单测覆盖 50/0/100/clamp。
  - **meta 黑条割裂**：删除输入框下方的独立 meta 黑条行（agent·model·provider）与
    虚线分隔行，身份并入底部单行 status（opencode/mimo 风格）；scroll 标记 `↑N`
    移至 hints 行；`#viewHeight` -8→-6、palette 居中 -9→-7 同步补偿。

## [0.7.1] - 2026-09-06

### Changed
- **Windows/PowerShell TUI 显示修复**（对齐 opencode / mimo-coder）：
  - **键盘 expand**：legacy conhost（无 WT_SESSION/TERM_PROGRAM）不发鼠标事件，
    `click to expand` 结构性失效——改为空输入框 `Enter`/`o` 展开/折叠选中工具块
    （含工具分组），提示文案改 `enter to expand/collapse`；帮助行补 `enter expand`。
  - **行距**：assistant 消息块加 1 行 margin（首条除外，opencode `marginTop=1` 语义），
    `#viewHeight` 基线 `rows-7` → `rows-8` 补偿。
  - **输入区 padding**：输入框上、下各加 1 空行；`┃` 左侧留白 1 → 2 空格。
  - **上下文进度条**：`█░` 块字符改 ASCII `#`/`-`（GBK 代码页下块字符按 2 格渲染错位），
    conhost 下同时跳过 block 字符 sparkline；文本行 `Nk / Mk · X%` 保留。
  - **install.ps1**：`aih.cmd` 启动器注入 `chcp 65001`（UTF-8），legacy conhost
    框线/块字符不再乱码（代码页随 cmd 会话退出自动恢复）。

## [0.7.0] - 2026-09-06

### Added
- **OC-R#1 — 流内 `finish_reason: network_error` 重试**（opencode v1.18.20 parity）：
  HTTP 200 但流尾以 `network_error` 结束的连接掐断不再被当成正常结束——partial 文本
  立即上抛走 AgentLoop 诚实续跑（partial 落 transcript + 有界续跑提示），空文本折入
  既有重试预算。`isNetworkErrorFinish()` + `NetworkFinishError`（`core/src/seams/llm-sse.ts`），
  与 CC#49 stall 同族不同源，共用 MAX_STALL_RESUMES。
- **CC-R#3 — prompt-cache 前缀稳定性**：① 系统提示新增前缀稳定性纪律段
  （稳定内容进前缀、易变内容走消息）；② `toolsetFingerprint()` 工具集字节级指纹，
  chat TUI registry 重建（plan↔build、extension 注册）时比对，变化→系统行警告 +
  记录破坏点；③ `/usage` 新增 prefix stability 归因（冷启不归因、空闲 TTL 由
  cacheTtlWaste 归因不重复计、其余 miss 按前缀破坏列出）。
- **CC-R#7 — remember 超预算显式警告**：memory.md 写入后超过 `AIH_MEMORY_BUDGET`
  时结果携带显式 `warning`（最旧条目将不再注入 + 建议 /tidy），不再静默截断。
- **OCL-R#1 — upstream-review 技能 hard gate**：上游机制断言必须本机源码实读 +
  强制 `file:line` 引用；CHANGELOG/PR 文本/子代理报告/memory/旧 review 均不算证据；
  失据降级为「未验证」。
- **MCP add_todo 批量形式**：`items` 数组（1–50）一次调用新增多条，避免 re-planning
  模型逐条调用（单次 replan 6 次、1.5 小时会话 76 次 add_todo 的churn）；`text`/`items`
  二选一校验，批量全部计入 stats。
- **Windows 兼容（mimo-code parity）**：① run_cmd/sandbox 在 win32 解析执行 shell——
  优先 Git Bash（真 POSIX 环境，/tmp、/c/... 路径映射），回退 PowerShell 且子进程强制
  UTF-8（zh-CN GBK 乱码会破坏 TUI 宽度计算）；`AIH_WINDOWS_SHELL` 可覆盖；纯函数
  `pickWin32Shell()` 拒绝 WSL System32 bash。② dev-tools shell 探测跟随后端 shell
  （Git Bash → bash 提示、PowerShell → PS 提示）。③ TUI：legacy conhost（无
  WT_SESSION/TERM_PROGRAM）仅启用 alt-screen（mouse/括号粘贴 CSI 不可靠）；#feed 统一
  把 BS `\x08` 归一为 DEL `\x7f`，composer/question/confirm/overlay/paste 全部生效。
- **冒烟 suite 挂起修复（AC#2 副作用）**：live tsserver 子进程 spawn 后从不关闭，三条
  stdio Pipe handle 把事件循环钉死。修复：`codeintel.ts` 对 stdio 三流逐一 `unref()`；
  `sandbox.ts` spawnCapture 关闭 capture fd（一次 1.5 小时会话发现 129 个陈旧 handle）；
  fake-llm-server `closeAllConnections()`；AC#2 显式 `pool.close()`。cli smoke 从挂起
  5+ 分钟 → 83s 正常退出（1591 ok / 0 FAIL）。

## [0.6.0] - 2026-09-05

### Added
- **MEA 独立判定层（LH#1 + CX-R#1 合并实施，roadmap 最高优先级项）**：融合
  LongHorizon Auditor 与 codex Guardian 双源，为 AIH 补齐此前未实施的"独立判定角色"。
  - **写动作 Guardian（默认开启，接管 ask 流程）**：需批准（ask）的写操作在弹人工确认前，
    先由独立无工具 LLM 按声明式 policy 评估 risk×authorization → allow/deny/ask。
    低风险 allow 自动放行、deny 拒绝并注入"不得规避达成同一结果"提示、连续 deny≥3
    触发 circuit-breaker 注入停止指令（对齐 codex MAX_CONSECUTIVE=3）。fail-closed：
    超时/解析失败/LLM 错误 → deny（`AIH_GUARDIAN_FAIL_CLOSED=1`），否则安全降级为
    人工确认。无可配 LLM 时自动降级为原人工 gate（零行为变化）。README/帮助见
    `--no-guardian`、`AIH_GUARDIAN=0`、`AIH_GUARDIAN_POLICY`、`AIH_GUARDIAN_FAIL_CLOSED`。
    （`cli/src/mea.ts`、`cli/src/gate.ts`、`cli/src/index.ts`）
  - **完成产物 Auditor（/goal 独立验证）**：goal 裁判判 met 后，再由独立 Auditor LLM
    依据 verified-state ledger（从会话日志采集真实工具输出，非 agent 自述）审计真实产物，
    产出 AuditReport；只有 complete+contract_aligned+integrity≥0.9 才算 trusted state，
    缺缺失/阻塞则降级为 not-met 并注入续跑。交互 `/goal` 与 `aih run --goal` 两条路径均接入。
    （`cli/src/mea.ts`、`cli/src/index.ts`）
- **Textual-grant bridge（`permissions` 工具）**：用户在对话里明确授权（"直接写"／
  "不用确认"）时，模型现在调用 `permissions` 工具把授权转成**真实** allow 规则
  （`SessionGate.grantRule`）——此前口头授权只是模型可见文本，gate 层继续逐条弹
  "write command needs approval"。授权本身仍要过**一次**人工确认（模型不得单方面提权）；
  `{"action":"status"}` 列出当前规则。系统提示新增 "Permission grants" 段规定只在
  用户明说时授予。（`cli/src/gate.ts`、`cli/src/general-tools.ts`、`cli/src/index.ts`）
- **CL-R#3 拒绝双段消息（cline 同构）**：所有权限拒绝 error 统一追加 REJECTION_SUFFIX
  （"这不是工具或系统故障，请向用户澄清后再继续"），覆盖 permission=deny、ask 被拒
  （含 doom-loop）、before-hook ask 被拒三个落点；Guardian deny notice 同步双段语义。
  （`core/src/tool-registry.ts`、`cli/src/gate.ts`）
- **KL-R#3 子代理权限传播（kilocode 同构）**：`RulesetGate.subagentGate()` —— 父 deny
  规则传播到子代理、allow/ask 不传播；子代理内 write→deny（以 tool error 呈现，
  拒绝≠终止）、read 放行。`SessionGate.denyRules()` + `makeSubagentGate` 供 task 与
  best_of_n 共享；子代理注册表排除 best_of_n/todowrite（防递归/防改父 todo）。
  （`core/src/seams/permissions.ts`、`cli/src/gate.ts`）
- **RulesetGate.explain()**：返回最高优先级 winning rule，SessionGate deny 时透出
  "denied by <file>"（规则来源可追溯）。（`core/src/seams/permissions.ts`、`cli/src/gate.ts`）

### Changed
- **OMP-R#1+OCL-R#4 重试升级**：`retryAfterHintFromHeaders()` 多源 hint 解析
  （retry-after-ms / retry-after 秒或 HTTP-date / x-ratelimit-reset(-ms)，epoch 量级
  区分，取最大值向上取整）；`QuotaError` 喂权威时序；`retryBackoffMs` 支持 floor——
  服务器 hint 是下界，抖动严格向上（hint→hint×1.5，60s 封顶），无 hint 保持 ±25%
  对称抖动。（`cli/src/seams/*`、`core/src/seams/llm-openai.ts`、`core/src/seams/llm-sse.ts`）
- **OMP-R#7 memory 截断 marker**：fitBudget 截断时尾部附可行动提示
  （edit .aih/memory.md or use /memory …）替代裸 (truncated)。（`cli/src/memory.ts`）
- **OMP-R#10 replay-policy**：deriveMessages 过滤 turn/end stopReason 含
  refusal/sensitive 的 turn 的 assistant 输出及其 tool 配对（避免孤儿 tool 消息触发
  严格模板 400）。（`core/src/session-log.ts`）
- **kl-R#5 截断 recovery 消息**（OMP turn-recovery 同构）：截断后的续跑指令升级。
- **TUI footer hint 模式感知**：run-or-copy 确认（[R]un [C]opy [N]o）时底部提示同步
  显示 `R run · C copy · N no`（此前硬编码 `y once · a always · n deny` 误导按键）。
  （`cli/src/tui.ts`）

### Fixed
- **Guardian 自动拒绝的归因修正（执行优先保持）**：guardian deny 曾被 surface 成
  "user rejected"——实际没有任何人按键，远程无人值守场景下用户误以为是自己答了确认框
  （实例：无害的 `tar tzf … | grep | head` 验证命令被 reviewer 误判为
  "truncated/malformed"）。现在 `SessionGate.lastDenySource` 区分来源，tool error
  显示 "guardian auto-denied <tool> (no human prompt answered)"。**刻意不弹二次确认**：
  长 loop 中每次 reviewer 误判都等人的话会卡死无人值守运行；预先经 `permissions`
  grant 授权的规则直接放行，guardian 根本不介入。（`cli/src/gate.ts`、`core/src/tool-registry.ts`）
- **bare-Esc 残留不再吞掉下一个按键**：question 提示里按单次 Esc 后，escape 机的
  `#held` 残留会把下一个 backspace/tab/回车当"双击检测的计时样本"吞掉（表现为
  退格失灵、回车要按两次）；现在被消化裸 Esc 的跟随字节回退到答案处理；完整序列
  （PageUp/方向键/鼠标）仍被正确吞掉。confirm 提示中 Esc = deny（footer 本就宣传
  esc 取消，此前会卡死确认框）。（`cli/src/tui.ts`）
- **sk- 脱敏形状收紧**：`/sk-[A-Za-z0-9_-]{8,}/` 会把 "auto-approve **ask-permission**
  tools" 误判成 secret（模型读到 "a[REDACTED] tools"，之后 edit 用被污染文本做
  old_string 失败 "old_string not found"）。现要求 20+ 连续 base62（无 -/_），
  真实 OpenAI 风格 key 仍被脱敏。（`cli/src/hooks.ts`）

## [0.5.2] - 2026-09-03

### Added
- **Shell execution for `aih run` on by default (opencode parity)**: the `run_cmd`
  shell tool (plus the rest of the local coding toolset) is now registered by
  default for `aih run`, `aih chat`, and `aih tools` — no `--dev` flag required.
  `--no-dev` disables it uniformly on all three paths. Previously the one-shot
  `run` command kept the whole set opt-in via `--dev`.
  (`cli/src/index.ts`)
- **Command workspace-boundary analysis (`shell-scan`)**: `run_cmd` now pre-analyzes
  each command for file-system writes and workspace-external paths (inspired by
  opencode's tree-sitter shell tool, dependency-free regex version). Detects write
  operations (`rm`/`mv`/`cp`/`mkdir`/`chmod`/`git add`…), resolves relative/`~`
  paths against the workspace, and flags external directories. The scan result
  (`isWrite`, `externalDirs`, `touchedPaths`) is surfaced in the tool result; a
  human-readable summary is attached. (`cli/src/shell-scan.ts`)
- **Shell-aware tool description (`shell-prompt`)**: `run_cmd`'s description now
  adapts to the detected OS/shell and documents workdir/timeout/keep_output all in
  one place, plus guidance to prefer dedicated tools over shell file ops.
  (`cli/src/shell-prompt.ts`)
- **TUI `!` prefix directly runs shell commands (opencode/mimo-code parity)**:
  typing `!ls` in the input line executes `ls` locally through the same
  `runShellCommand` executor as the `run_cmd` tool (sandbox + env filter + timeout
  + middle-truncation) — it is **never sent to the LLM**. Runs even mid-turn
  (not steered), and is recorded as `run_cmd` tool/call+result events so the
  existing `/shell` (IT#1) and `/fix` (IT#2) shell-context machinery picks it up.
  (`cli/src/index.ts`) — mirrors opencode/mimo-code's `!` shell mode and codex's
  `!` prefix direct-exec "You ran" behavior.

### Changed
- `run_cmd` gains a `workdir` parameter (alias recommended over `cd`; `cwd` kept
  for backward compatibility).

## [0.5.1] - 2026-09-02

### Added
- **Deep code-review pipeline (AC#1, AtomCode borrow)**: the `code-review` skill now
  supports a deep mode — four parallel read-only review dimensions
  (correctness / security / performance / tests-contracts) each reviewing the full
  diff through its own lens → deterministic `mergeFindings` dedup (file + line
  overlap + title similarity, high-priority wins, cross-dimension credit) → an
  **independent verify agent per candidate finding** (KEEP/DROP, diff is
  authoritative) → human-readable report by priority + append-only JSONL audit trail
  (`.aih/reviews/`). Also derives a deterministic **impact plan** from the diff
  (changed files + high-risk symbols) to bound reviewer exploration.
  (`cli/src/review-pipeline.ts`, `.aih/skills/code-review/SKILL.md`)
- **Lightweight code-intel tools (AC#2, AtomCode borrow)**: three read-only tools —
  `list_symbols` (per-file outline), `read_symbol` (signature + docs), and
  `find_references` (workspace-wide, cross-file) — backed by an on-demand language
  server pool (`cli/src/codeintel.ts`). Zero new dependencies: a minimal JSON-RPC
  2.0 / stdio LSP client (`Content-Length` framing, bounded parser) plus a
  `tsserver` native-protocol adapter (1-based coordinate normalization, serialized
  `open` handshake that waits for project load, identifier-hit positioning via
  `navtoLocate` — quickinfo/references return nothing at the span start).
  Servers resolve per workspace (local `node_modules/typescript` first, real PATH
  `tsserver` second; npm-lifecycle `.bin` shims are excluded as false positives);
  child processes get the same secret-filtered env as run_cmd and are `unref`ed so
  a live server never keeps the agent hanging on exit. Missing servers degrade to
  a clear error; all three tools join the parallel read-only class (F#29).
  (`cli/src/codeintel.ts`, `cli/src/dev-tools.ts`)

### Fixed
- **Context window fell back to 131072 for models known only to models.dev
  (P#48 gap)**: `resolveContextWindow` never consulted the committed snapshot —
  a model whose window was not declared in `aih.json` (e.g. `glm-5.3-flash`
  on a catalog-connected provider) landed on the hardcoded 128k default even
  though models.dev reports 1M. The snapshot is now the last data-driven tier
  (flag > env > live probe > config > **snapshot** > default), matched on the
  bare model name with an optional provider-scoped pin; when providers
  disagree on a window the MODE wins (tie → smaller) — claiming more than the
  model supports hard-fails requests, under-claiming only compacts earlier.
  Also refreshed the committed snapshot (27 → 7408 entries, adds
  glm-5.3*/deepseek-v4* windows and prices). (`cli/src/cost.ts`,
  `cli/src/index.ts`, `scripts/model-metadata.snapshot.json`)
- **TUI side panel truncated the cost/throughput row**: the CONTEXT panel
  joined cost + tok/s + stream tok/s + CH% into one dot-joined line that
  overflowed the ~24-32 col panel and cut off mid-number. Layout is now:
  cost on its own line, the two throughput figures sharing the next
  (`N tok/s · stream M tok/s`), cache rate on its own line. Adds
  `Tui.panelLinesForTest()` + 9 smoke assertions. (`cli/src/tui.ts`)

## [0.5.0] - 2026-09-02

### Added
- **Provider catalog + `/connect` interactive login (opencode `/connect` parity,
  OpenAI-compatible scope)**: `connectCatalog()` returns a curated catalog of
  OpenAI-compatible providers (popular first, then alphabetical; native-SDK
  providers like Anthropic/Google excluded) with stable baseUrl / apiKeyEnv /
  default model. `/connect` (TUI) and `aih connect [<id>]` walk the user through
  provider selection → API key entry (persisted to the AIH env file chmod 600,
  NEVER written into aih.json) → provider saved into aih.json via
  `saveProvider()` (credential-safe: `apiKeyEnv` names the env var, key itself
  never stored) → model applied immediately. Providers not yet configured
  surface as "+ connect" entries at the bottom of the `/model` picker.
  (`cli/src/provider-catalog.ts`, `cli/src/config.ts` `saveProvider`,
  `cli/src/index.ts` `/connect` + `openConnectPicker`, `cli/src/slash.ts`)
- **Docs-site tutorial extension, batch 3 (zh + en)**: applied the same "beginner primer + real code walkthrough + logic diagram" treatment to the remaining mechanism chapters — Ch.2 (project structure & dev env: monorepo layer map + root `package.json` walkthrough, reuses `arch-overview.svg`), Ch.6 (agent system: bounded-retry fallback constants + `StallError`/`QuotaError` handling walkthrough, reuses `agent-loop.svg`), Ch.12 (CLI & TUI: `main()` dispatch walkthrough — trust gate → TTY default → `switch` routing, new `cli-dispatch.svg`), Ch.14 (skill system: `discoverSkills` name-dedup + `parseSkillMd` + BM25 `tokenize` CJK-bigram walkthrough, new `skill-load.svg`), Ch.15 (community & reusable skills: `installRemoteSkill` staging + atomic-rename + version-aware no-op walkthrough). Added two new SVG logic diagrams (`cli-dispatch.svg`, `skill-load.svg`); now 9 tutorial SVG diagrams total. Build/check PASS, all chapters + diagrams served with correct depth-aware paths (200).
- **Docs-site tutorial extension (zh + en)**: extended the same "beginner primer + real code walkthrough + logic diagram" treatment to more mechanism chapters — Ch.5 (tool system: `ToolDefinition`/`register`/`invoke` five-stage guard, reuses `guard-pipeline.svg`), Ch.10 (snapshots & file system: sandbox-backend resolution priority, env-policy), Ch.11 (event stream: observer `LoopObserver` code + `goal/judge` three-state verdict), Ch.13 (plugin/extension: `ExtensionApi` code + load-order + hook-waterfall placement). Added two new SVG logic diagrams (`event-stream.svg`, `extension-hooks.svg`) alongside the earlier `session-fork.svg`/`permission-floor.svg`. Build/check PASS, all 7 tutorial SVG diagrams served and embedded with correct depth-aware paths.
- **Docs-site tutorial refinement (zh + en)**: index ("导读 / How to read") table of contents now lists every chapter on its own line instead of merging several `·`-joined entries; repeated "three integration shapes" content is de-duplicated into a single canonical home in Ch.8 with cross-references from Ch.1/Ch.3/Ch.16; all bare `(chNN)` / `(../page)` cross-references converted to real clickable links. Deepened Ch.4 (session system) and Ch.9 (permission system) with beginner-friendly primers, real code walkthroughs (append/fork/restoreTo/coverageDigest; PolicyGate request), and two new SVG logic diagrams (`session-fork.svg`, `permission-floor.svg`). Added a Runoob-style "first use" beginner case to Ch.1 that exercises the real offline `--mock` pipeline.
- **Docs-site tutorial book (`docs-site`)**: a five-part, eighteen-chapter bilingual
  (zh + en) "AIH: A Learner's Guide & Source Deep-Dive" modeled chapter-by-chapter on
  opencodebook.xyz, from install to kernel and mechanisms to ecosystem/practice. Added
  grouped sidebar navigation (build.mjs / check.mjs now support nested nav groups and
  nested `tutorial/*` pages, with depth-aware relative links and assets) plus three SVG
  diagrams (layered architecture, tool guard pipeline, agent loop). Served from the
  existing GitHub Pages `docs.yml` workflow.
- **Rules loading (opencode `rules` parity)**: AIH now reads and injects project
  `AGENTS.md` (falling back to `CLAUDE.md` walking up from cwd), global
  `~/.claude/CLAUDE.md` (Claude-Code compat, disable via
  `AIH_DISABLE_CLAUDE_CODE[_{PROMPT,SKILLS}]`), and config `instructions`
  (paths/globs/URLs) into the system prompt as mandatory `# Project rules`.
  (`cli/src/rules.ts`)
- **Provider policies (opencode `policies` parity)**: `policies` config controls
  which configured LLM providers are usable — `provider.use` with `*`/`?`
  wildcards, last-match-wins, global-over-project; a denied provider is blocked
  at resolve and hidden from the model catalog even if configured.
  (`cli/src/policies.ts`)
- **Configurable keybinds (opencode `keybinds` parity)**: `tui.json` (project +
  `~/.aih` global) remaps the core single-byte actions `palette` (default
  ctrl-p), `help` (default `?`), `toggleMode`; collisions with reserved keys are
  dropped with a warning. (`cli/src/keybinds.ts`)
- **Credential ownership isolation (OC#7, OpenClaw "secrets have owners")**:
  a credential-class failure (auth 401/403, or quota exhaustion) on a provider
  DEGRADES THAT OWNER — recorded in a user-level `owner.json` with a redacted
  reason; the error still propagates (no silent auto-fallback to another
  credential). A later successful call auto-clears the degradation. `aih models`
  marks degraded owners (`⚠ degraded`), and `aih models`/`aih stats` print a
  redacted "degraded owners" report with `--clear-degraded` to reset.
  Hard-fail still blocks: missing key / unknown provider / policy-denied
  providers throw at resolve time. (`cli/src/owner-state.ts`,
  `core/src/seams/llm-openai.ts`)
- **Live-verify & check-existing-first disciplines (OC#3, OpenClaw "Start"
  borrow)**: two default working rules injected into the system prompt —
  ① a user-visible behavior must be exercised through the REAL production
  path before it is claimed done (skipping requires a concrete infeasibility,
  never "to save effort"); ② before proposing/building anything custom, do a
  BRIEF gate for an existing OSS library / installed skill / already-shipped
  capability (a brief gate, not a research assignment). (`core/src/prompts.ts`
  `LIVE_VERIFY_DISCIPLINE`, injected in `loadSystemPrompt()`)
- **Core per-call tax + repeat-demand→seam governance (OC#2, OpenClaw "Two
  layers, two bars" borrow)**: an explicit decision heuristic — every core
  tool/prompt line/config key reaches EVERY operator's EVERY model request, so
  core admission is reviewed strictly (default: don't); one-off / domain logic
  goes to skills (`.aih/skills`) or extensions (`.aih/extensions`) which carry
  no such tax and are encouraged to grow. When the same capability is
  independently wired in ≥2 places, the right response is a CONTRACT not a
  string of merges: land the seam in core/SDK, migrate the bundled impl onto
  it, hang the rest as plugins. Decision rule in `docs/decisions.md` + `APP.md`
  §6 rule 4.
- **Trust model statement (OC#4, OpenClaw "trust boundary" borrow)**: AIH is a
  LOCAL SINGLE-OPERATOR trust model — the trust boundary is the host OS user,
  session ownership/visibility is an availability feature NOT a security
  boundary, and a prompt-injection-only chain is not a security bug unless it
  crosses a hard boundary (allow/ask/deny gate, credential redaction + owner
  isolation, sandbox seam, tool `deny` red line). Documented in `APP.md`
  §3 (capability boundary → new "trust model" subsection) and `README.md`
  (permissions section).
- **Config self-healing via `aih doctor --fix` (OC#5 residual)**: the OC#5
  guard makes an OLD build refuse to open a NEWER config (fail-closed); this
  adds the complementary direction — a NEW build helps a user migrate a legacy
  config UP. `aih doctor --fix` scans the global user config + project
  `aih.json` / `.aih/config.json`, detects legacy shapes (currently the missing
  `schemaVersion` stamp — rule `M1-schema-version-stamp`), backs up each changed
  file to `<path>.bak.<ts>`, and rewrites it in the canonical stamped form.
  Idempotent (a second run is a no-op); unparseable files are left for the user
  to fix. The top-level flat `model`/`baseUrl` are still a valid current shape
  and are deliberately NOT touched. (`cli/src/migrate.ts`, `cli/src/index.ts`)
- **Maturity scorecard / coverage-ID + evidence-mode classification (OC#6,
  OpenClaw taxonomy.yaml borrow)**: `aih coverage [--profile NAME]` derives a
  STABLE coverage registry directly from the smoke test's section headers (so
  it never drifts from the tests), tags each group with an evidence mode (`mock`
  / `live`), and selects a subset per profile — `smoke-ci` runs only mock
  groups, `release` additionally runs `live` groups (real provider/channel,
  currently TP#6's API-key bench), and `personal-agent` sits in between.
  `npm run eval:quality` runs the release coverage matrix. (`cli/src/coverage.ts`,
  `cli/src/index.ts` `cmdCoverage`, `package.json` `eval:quality`)
- **BuffBench-style quality eval suite + baseline regression gate (FB#4)**:
  `aih quality [--mock] [--json]` runs the committed quality task suite
  (`evals/quality.tasks.json` — fixed tasks with expected products, auto-scored
  against `expect` substrings), then compares pass/fail against
  `evals/quality.baseline.json` (cellId / `task__*__rN` wildcard patterns that
  MUST pass) to catch "改 A 坏 B" regressions. Reuses the P#46 `runExperiment`
  runner. A `live` run (real model) gates on regressions; a `--mock`/CI run is
  deterministic and informational (mock subjects can't demonstrate real
  quality). `npm run eval:quality` runs the suite (mock) then the coverage
  matrix. (`cli/src/eval.ts` `loadQualitySuite`+`compareToBaseline`,
  `cli/src/index.ts` `cmdQuality`, `evals/`)

### Fixed
- **Overlay picker scroll highlight drift ("chose one, got another")**: the
  `/model` / ctrl-p palette rendered its selection mark by comparing a
  window-relative loop index against the GLOBAL `sel`, so once the list
  exceeded the visible rows the highlighted row and the actually-selected
  entry drifted apart. Extracted `paletteWindow(sel, len, maxRows)` returning
  `{ top, highlight }` and render with the window-relative `highlight`.
  (`cli/src/tui.ts`)
- **Phantom near-full context / false compaction on model switch**: free-tier
  gateways (opencode zen go) report CUMULATIVE/garbage `prompt_tokens`
  (observed 949K / 3.2M on a ~78K-token conversation). The old plausibility
  gate (`prompt_tokens ≤ 2×window`) admitted those once the window grew to 1M
  (deepseek-v4-flash), so switching big-pickle (200k) → deepseek-v4-flash
  (1M) flashed "949K / compact needed" (949K ≥ 0.8×1M). Plausibility now also
  cross-checks the local chars÷4 estimate in BOTH directions — report ≫
  estimate → cumulative garbage (estimate wins); estimate ≫ report → stale
  sample (estimate wins). Mirror guard in `agent-loop.ts` (`plausible`) and
  `cost.ts` `lastContextTokens`. (`core/src/agent-loop.ts`, `cli/src/cost.ts`)

## [0.4.0] - 2026-08-29

### Added
- **Quota auto-resume (CC#51)**: when the provider reports usage-limit
  exhaustion (429/402 + quota/limit/credits, or `Retry-After` ≥ 60 s), the
  interactive session waits for the reset (default 60 s, cap 1800 s) and
  re-issues the **same** rejected call — not a re-run of the turn. Bounded to
  2 waits (`MAX_QUOTA_WAITS`); TUI shows a wait line; `AIH_QUOTA_AUTO_RESUME=0`
  disables. Non-interactive `run` fails fast. `quota_wait` session event.
- **Read-only auto-allow (CC#54)**: read-only tool calls (list, read, glob,
  grep, etc.) are auto-allowed without an `ask` prompt, reducing approval
  friction for safe operations while write/dangerous calls still require
  confirmation.
- **Credential scope (CC#59)**: sensitive headers (`api-key`, `x-api-key`,
  `x-goog-api-key`, `x-nano-fp`, `x-amz-security-token`, etc.) are dropped
  when the effective request host differs from the provider's home host,
  preventing key leakage to third-party or proxy endpoints.
- **BOM tolerance (CC#55)**: `readJson` strips a UTF-8 BOM so config and
  JSON state files saved with a BOM prefix parse correctly.
- **MCP empty-schema (CC#56)**: tools with an empty or missing `inputSchema`
  no longer break the MCP handshake; they are exposed with a no-arg schema.
- **/usage Loops (CC#57)**: `/usage` now shows a per-loop (per-tool-call)
  token breakdown alongside the session totals.
- **TUI truncation (CC#58)**: long lines in the TUI transcript truncate
  cleanly at the terminal width instead of wrapping and overflowing.
- **Injected-source isolation (CC#60)**: approval requests with
  `source: "injected"` (from `serve`/`attach` remote `POST /message`) are
  rejected directly without a human prompt — a remote message cannot spoof
  an approval. TTY keyboard approvals are unaffected.
- **Question tool (35cec96)**: the agent must use the `question` tool for
  user decisions instead of writing the question as assistant text and
  continuing to act. The user actually sees and answers the question before
  the agent proceeds (opencode / Claude Code parity).
- **Bilingual docs site (77dfa9a, 5811654, 72456f3)**: static zh + en docs
  at `docs-site/` with opencode.ai / Starlight typography, 8 new page pairs
  (agents, commands, coding, tui, architecture, troubleshooting, development,
  changelog), language switcher, real TUI screenshots, and a GitHub Pages
  deploy workflow (`.github/workflows/docs.yml`). Live at
  `https://summit4you.github.io/aih/`.
- **Harness health scorecard (PE#3)**: `aih scorecard [--format json]`
  reports the six playbook metrics — completion rate, rework rate,
  escalation rate, recovery time, cost per verified result, and guide
  growth — computed purely over the existing append-only session log +
  `.aih/memory.md` (no new storage, zero new dependencies).
- **`escalate` session event (PE#4 foundation)**: a first-class
  "stop and hand a human a decision" primitive (distinct from `ask`), with
  `reason` / `options` / `safestDefault`. Gives the scorecard's escalation
  metric a real data source and sets up bounded sensor/budget escalation.
- **Safety seam (PE#1 / PE#2 / PE#4)**: the harness enforces safety, not the
  model. Three pieces, all pure-function seams (zero new dependencies),
  adjudicated by the kernel after every tool batch:
  - **PE#2 budget hard constraint + tripwire** — `BudgetTracker`
    (`core/src/budget.ts`) accumulates cost / write-count / wall-clock and
    guards a `denyPaths` scope list. A hard bound (`maxCostUsd` / `maxWrites`
    / `timeoutMs` / `denyPaths`) → `escalate` + `stopReason="escalated"`,
    stopping the turn. A soft **tripwire** (task cost ≥ 2× session mean) →
    `onTripwire` hint once (latched per task), non-blocking. Configure via
    `aih.json` `safety.budget` or `AIH_BUDGET`
    (`maxCostUsd=1|maxWrites=5|timeoutMs=60000|denyPaths=a|b`).
  - **PE#1 computational sensors** — `SensorLoop` (`core/src/budget.ts`) +
    `cli/src/safety.ts` executor. After a write tool succeeds, run a declared
    `{name, command, onTools?, pathPrefix?, timeoutMs?}` check (children get
    `buildChildEnv`, so they inherit **no secrets**). Exit 0 = green; red →
    bounded retry (`AIH_SENSOR_RETRIES`, default 1) → escalate. Configure via
    `safety.sensors` / `AIH_SENSORS`.
  - **PE#4 escalate primitive** — `AgentLoop.escalate()` emits a
    **model-invisible** `escalate` event (`reason` + `options[2-4]` +
    `safestDefault`; `deriveMessages` skips it). Non-interactive `run` prints
    the options + safest default then **exits code 3** (`ESCALATE_EXIT_CODE`);
    the TUI renders the options for a human to choose.
  - **Recovery test** — `test/recovery.sh` drives the real CLI + mock LLM over a
    real persisted session: escalate event persisted & replayable, exit code 3,
    and a mid-turn crash (dispatch, no result) → resume reads the checkpoint,
    parks the tool (indeterminate, outcome UNKNOWN) and does **not** re-dispatch
    it. 10/10, stable.
- **Intelligent Terminal UX group (IT#1–IT#5)**: context flow + deterministic
  error-detection + session management, borrowed as pure seams:
  - **IT#1 shell context** — `shell_context` tool + TUI `/shell` +
    `AIH_SHELL_CONTEXT=auto`: the agent proactively reads recent shell
    commands / exit codes / cwd / output tails (`cli/src/shell-context.ts`).
  - **IT#2 error detection + one-click fix** — `cli/src/error-detect.ts`
    deterministically (no LLM) detects `run_cmd` failures, lights a red
    `⚠ N failed` status badge, and TUI `/fix` sends the failure context to the
    agent for a fix suggestion.
  - **IT#3 `?` prefix quick task** — `cli/src/question.ts`
    (`classifyQuestionPrefix` / `buildQuestionContext` / `composeQuestionPrompt`):
    a TUI input line starting with `?` starts an agent task with the current
    shell context auto-injected.
  - **IT#4 `/sessions` panel** — `cli/src/sessions.ts`
    (`buildDashboard` / `formatDashboard`): a TUI session-management surface
    listing active + saved agent sessions with status, token usage and cost;
    `/sessions kill <id>` cancels a running job, `/sessions view <name>` shows
    a per-session summary.
  - **IT#5 run-or-copy approval** — `cli/src/clipboard.ts` + TUI `askRunOrCopy`:
    a write-kind `run_cmd` approval is now explicit `[R]un / [C]opy / [N]o`
    (copy degrades to printing the command when no clipboard is available),
    never auto-running.
- **`aih measure` distance ruler (PR#2)** — `cli/src/measure.ts` answers
  "how much did it change, and how" (vs the scorecard's "how good is it
  now"): `measure distance <a> <b>` (per-surface structural diff, missing
  snapshot → explicit degraded, exit 1), `measure stream <traces>` (tool-flow
  L1 + bigram Jaccard with a seeded permutation test), and
  `measure crystallize <evolved> <neutral>` (disposition stability; drift →
  exit 1 + `DRIFTED`). Pure functions, `--json` out.
- **`aih session rm --all`**: a real `-a/--all` boolean flag removes every
  saved session (the correct bulk-clear); per-name guards unchanged (path
  traversal still rejected, non-session names still error instead of a fake
  "removed"). Fixes `aih session rm *` where the shell expanded `*` into CWD
  files and the old per-file loop errored with no way to bulk-delete.

- **Multi-strategy `best_of_n` (Freebuff FB#1, borrowed from CodebuffAI/freebuff
  `editor-multi-prompt.ts`)**: pass `prompts` (an array of short strategy
  prompts) and each candidate works the SHARED task context plus its own
  strategy direction (candidate i follows `prompts[i % len]`) — wider
  exploration than N samples of one prompt. The result carries `strategies`;
  the judge labels each candidate with its strategy so it can weigh "right
  approach" as well as "right answer". Omit `prompts` → unchanged
  single-prompt behavior. `cli/src/maxmode.ts` + `cli/src/general-tools.ts`
  + smoke coverage.
- **Two-judge panel for `best_of_n` (Freebuff FB#2, borrowed from freebuff
  BuffBench independent-judging)**: opt-in via `AIH_SECOND_JUDGE_MODEL`
  (`buildJudge2Llm` reuses the primary model's provider/base-url/api-key,
  only the model id differs). The two judges run in PARALLEL
  (`Promise.allSettled`); the primary's pick is kept (median of two). A
  disagreement or a failed judge is flagged (`judgeDegraded`) and warned on
  stderr — a silently-dropped judge would turn the panel into one opinion.
  Both judges failing → hard error. The panel is a generic `judgePanel<V>()`
  helper so the `/goal` judge can share the same discipline (roadmap FB#6).
  Absent → single-judge behavior (unchanged). `cli/src/maxmode.ts` +
  `cli/src/index.ts` + smoke coverage (agreement / disagreement / second
  failed / primary failed / both failed).
- **Compaction "historical memory only" guard (Freebuff FB#3, borrowed from
  freebuff `context-pruner.ts` summary positioning)**: the compaction
  `SUMMARY_TEMPLATE` now tells the model the summary is HISTORICAL MEMORY
  ONLY — not dialogue, not an output template, not a tool-call format;
  continue from the live user message and use real tool calls when actions
  are needed. Guards against the model copying the summary's structure into
  its live output after compaction. `core/src/agent-loop.ts` + smoke
  coverage.

### Changed
- **webfetch hardening (opencode/MiMo parity, zero new deps)**: the old
  implementation was one-shot — a single 20s fetch with a bot UA, no Accept
  header, body downloaded before the size check, and bare error text
  ("webfetch failed: HTTP 403") that told the model nothing it could act on.
  In flaky networks every transient blip became a visible failure. Now:
  browser-grade UA + Accept/Accept-Language headers (bot-block resistance);
  one bounded retry on network failures (connect/DNS/TLS/abort); Cloudflare
  `403 + cf-mitigated: challenge` → honest-UA retry (opencode pattern);
  configurable timeout — tool `timeout` arg (seconds) > `AIH_FETCH_TIMEOUT_MS`
  > 30s default, hard cap 120s; `content-length` precheck before downloading;
  actionable failure messages (FA#2: state what happened AND what to try next —
  alternate endpoint / websearch).
  `cli/src/general-tools.ts` + smoke coverage (timeout resolution, challenge
  detection, retry bounds, honest-UA path, tool surface).

### Fixed
- **Slash-command parsing**: pasted code whose comment starts with `//`
  (e.g. `// setvbuf(stdout, …)`) is no longer parsed as a slash command;
  unknown `/…` reaches the model as a normal message (opencode
  `parseSlashCommand` parity).
- **Subagent partial results (CC#50)**: subagent turns that produce partial
  output before an error no longer lose the partial text.
- **load_skill dedup (CC#52)**: loading an already-loaded skill is a no-op
  instead of duplicating its instructions in context.
- **Permission ask for write tools (CC#53)**: write-kind tools that are
  marked `ask` now consistently prompt before executing (previously some
  paths bypassed the gate).
- **Tool-output budget marker (FA#2)**: when a turn's total tool output
  exceeds `TURN_TOOL_BUDGET_CHARS` (12K), later results are replaced by a
  marker. The old cryptic `[turn budget: truncated]` made the model
  blind-loop (30+ steps re-issuing tools, each also truncated, wrongly
  inferring the environment had failed). The marker is now an explicit,
  actionable directive — stop running read/debug tools, wrap up from what it
  has, and that a new message resets the budget on a fresh turn — appended as
  a trailing user message so tool-call pairing is preserved.
- **Language rule covers progress notes**: the system-prompt language rule
  now requires **every** user-facing text — the final answer *and* the short
  progress notes written before/between tool calls — to match the user's
  major language, so a Chinese user no longer sees a wall of English
  tool-narration mid-task.

## [0.3.0] - 2026-08-26

### Added
- **Per-event session durability**: chat now appends every event to the
  session file as it happens (byte-watermarked incremental flush), so a long
  multi-tool turn survives a crash or kill instead of living only in memory.
- **Extension API (P#39)**: `.aih/extensions/*.mjs` modules — `registerTool`,
  `registerCommand`, `on("tool:before" | "tool:after" | "turn:end")` handlers
  that can cancel calls or rewrite results in place. `--no-extensions`
  disables loading; gated by the project trust decision.
- **Session tree (P#37)**: events carry optional parent links; `aih session
  tree` renders the branch structure and TUI `/tree` navigates it, with fork
  from any historical point (D#10 CLI already existed).
- **Steering + follow-up queues (P#35)**: input typed while busy now lands
  mid-turn (between tool batches) instead of waiting; follow-up queue drains
  at the natural stop point.
- **Project trust gate (P#40)**: repo-supplied extensions/skills/config stay
  dormant until the directory is trusted; decisions persist per-path in the
  user dir; `--trust` / `--no-trust` one-shot overrides.
- **Eval framework phase 1 (P#46)**: Experiment → Cells → Attempts → Results
  data model for measuring harness changes against fixed task sets.
- **Context prune + lazy archive (MK#43)**: oversized old tool results are
  pruned once per session start and retrievable verbatim via `archive_read`.
- **Compaction coverage digest (MK#42)**: summaries stamp what they replace;
  derivation verifies coverage before honoring them.
- **Offline installer**: `scripts/offline-package` builds a self-extracting
  POSIX `.sh` + Windows `.ps1` bundling runtime deps and a merged global
  config (providers/models included); sandboxed install/uninstall sanity
  tests run at build time. Uninstall never touches `$PWD/aih.json`.
- **Cache-hit rate (#41)**: `/usage` reports prompt-cache hit rate when the
  provider returns cached-token counts.
- **Per-model context window (F#34)**: `providers.<name>.models[]` entries now accept
  the object form `{ "model": "<id>", "contextWindow": <n> }` (mixable with plain
  model-id strings). The model-level value overrides the provider-level
  `contextWindow` for that model only, so one provider can serve models with very
  different windows (e.g. 1M vs 190k) and the TUI context panel, `/model` picker
  and `aih config` all report the right number. Resolution order:
  `--context-window` > `AIH_CONTEXT_WINDOW` > live llama.cpp `/slots` probe >
  `models[<id>].contextWindow` > `providers.<name>.contextWindow` > global > 128k.
  `aih.json` for the bundled opencode provider now declares each model's real
  window (x-preview-f-free / nemotron-3-ultra-free = 1M).
- **One-line installer**: `scripts/install` (bash, macOS/Linux/WSL) and
  `scripts/install.ps1` (PowerShell, Windows) — curl|bash / irm|iex installers
  that download from GitHub Releases, detect platform, check Node.js ≥ 20,
  extract to `~/.local/share/aih` (XDG), symlink to `~/.local/bin`, and auto-
  configure PATH. Supports `--binary` (local tarball), `--version`, `--dir`,
  `--no-modify-path`. Idempotent (skips if already at same version).
- **Package script rewrite**: `scripts/package` now produces a self-contained
  tarball with an ESM launcher (`aih`) + bundled `node_modules/` — no
  `npm install` needed at install time. Release flow: `gh release create`.
- **Deterministic workflows** (F#33 / P1#6): `.aih/workflows/<name>.mjs` modules
  exporting `phases`; `aih workflow list` / `aih workflow run <name>
  [--format json]`. Phases run sequentially; each phase is one agent call
  (`prompt`) or a parallel fan-out (`prompts`). Substring gate (`expect`) and
  bounded `retries` per phase; fail-fast on the first failing phase.
- **Goal/judge events** (P0#3): `goal/judge` structured event appended to
  session logs whenever the TUI runs a `/goal` verdict check; `aih run --goal
  <condition>` performs bounded auto-continuation until the judge reports the
  goal met or the round budget (`AIH_GOAL_ROUNDS`) is exhausted.
- **Post-write auto-formatting** (F#27): `write_file` / `edit` / `apply_patch`
  detect prettier > biome > eslint `--fix` by walking up from the written file;
  formatting failures never block the write and surface as a `formatNote`
  (`AIH_FORMAT_TIMEOUT_MS`, default 15000).
- **Parallel read-only tool calls** (F#29): consecutive read-only tool calls in
  one step execute concurrently, capped at `AIH_TOOL_CONCURRENCY` (default 4);
  write tools stay serial; results are logged in the original call order
  regardless of completion order (codex `parallel.rs` parity).
- **Repo hygiene** (F#32): this changelog and `.devcontainer/` giving
  in-container agents a stable environment (`postCreateCommand` bootstraps and
  builds automatically).
- **User-level memory + background jobs + memory tidy** (P0#2 / D#13 / E#17):
  `remember` gains `scope: project|user`; `/bg <prompt>` dispatches isolated
  background agent turns with a live status line; `aih tidy` / `aih distill`
  dedup memory and mine repeated flows.
- **BM25 skill relevance + streaming TPS** (P1#4 / F#30): installed skills are
  ranked against the user query and auto-surfaced before each turn; per-request
  streaming throughput (completion tokens / real generation ms) is shown in
  `/usage`, `aih stats`, and the TUI context panel.
- **Skill-driven hook config** (D#11): a skill's `SKILL.md` front matter may
  declare `secretPatterns` (semicolon-separated regex sources) that the
  built-in redaction hook masks in addition to the credential table; invalid
  patterns are skipped and never break the turn.
- **Agent Teams (minimal)** (D#15): `aih team` manages a roster, a task board,
  and a per-agent mailbox under `.aih/team/`; `dispatch` runs one agent turn
  against a claimed task and mirrors the outcome back onto the board.
- **`/find` tool-output search** (T#22): search across every tool's output
  (the expanded content, including the 32KB in-band cap), expand matched tools
  and scroll the first hit into view; `run_cmd keep_output=true` still persists
  the full uncapped output for external inspection.

### Fixed
- **Context panel truthfulness**: free-tier gateways reporting cumulative or
  garbage `prompt_tokens` (observed 28M on a ~500k-token conversation) no
  longer reach the display — usage samples are window-bounded, a compaction
  is a hard provenance cutoff, and stale samples outgrown by the log fall
  back to local estimation. `-c` resume, `/model` switch and post-compact
  views all show the real current size.
- **CJK-aware token estimation**: flat chars÷4 undercounted Chinese + JSON
  sessions ~3×, hiding context overflow until providers failed; estimation
  now weights CJK ≈1 token/char and prices assistant toolCall args.
- **Opaque-500 overflow recovery**: near-window HTTP 4xx/5xx / transport
  failures are treated as suspected overflow — compact then retry once
  (free-tier gateways hide real context overflows behind generic 500s).
- **Compaction recent-tail guarantee**: giant turns no longer collapse the
  entire conversation into the summary; the newest user turn is kept
  budget-truncated (with marker) plus as many whole follow-up messages as
  fit, keeping call↔result pairing intact.
- **LLM retries were silently disabled**: the `AIH_RETRIES` parse produced
  `retries: 0` when unset. Default is now 6 attempts with exponential
  backoff (400ms→8s, ±25% jitter) so provider blips ride out invisibly.
- **question tool renders once** with the user's answer shown (`→ answer`);
  cancelled questions render a `(no answer)` marker instead of duplicating.
- **Session store hardening**: atomic publish via temp+rename, torn-tail
  repair on load, and an empty log never truncates an existing session file.
- **TUI flush row-diff**: only changed rows are written and shrinking frames
  erase surplus lines — geometry changes no longer clear the whole screen.
- **tool-call pairing invariant**: length-truncated responses fail their
  tool calls synthetically ("arguments may be truncated; re-issue") and
  aborted batches pair skipped calls with cancelled results.
- **steering while busy** lands mid-turn instead of waiting for turn end.
- **Capacity-burst retry patience**: gateway capacity failures (zen's
  "Upstream request failed: Endpoint is unavailable") triple the retry
  budget — ~2 minutes of backoff patience at the 8s cap instead of ~20s —
  so free-tier flaps ride out invisibly. Plain 5xx keeps the base budget.

## [0.2.0]

### Added
- Codex-inspired hardening: child-process env policy strips secret-like
  variables (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`, `AIH_*API*`) before spawning
  tools; `--debug-prompt` prints the exact model-visible messages per LLM call;
  skill roster injected into the system prompt within a ~2% context budget.
- Multi-model catalogs: providers may declare `models[]`; ctrl-p and `/model`
  switch between verified models at runtime.
- Live context-window detection and proactive / reactive / manual compaction
  with verbatim recent-tail preservation and rolling summaries
  (`compactNow()`, `/compact`); user-query invariant keeps Qwen3-style strict
  chat templates working after compaction.
- TUI design pass (split/unified layouts, paste fix) and richer session
  introspection.

## [0.1.0]

### Added
- Initial harness: `AgentLoop` step engine with max-steps handoff prefill,
  `SessionLog` append-only JSONL persistence + fork/replay, `ToolRegistry`,
  `PolicyGate` / `RulesetGate` approval flows, path-scoped write approvals,
  plan/read-only mode.
- MCP server exposing app context/actions; CLI entry points
  (`run` / `chat` / `tools` / `describe` / `sessions`), bundled todo-app
  example, OpenAI-compatible adapter with SSE streaming and 429/5xx retries.
- Contract docs (`APP.md`, `harness.yml`) and gates: `doctor`, `check`,
  smoke tests, full `eval`.
