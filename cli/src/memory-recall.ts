/**
 * KL-R#2 — 零依赖检索型记忆（词元重叠打分 + 去重 + 字节封顶）。
 *
 * 借鉴 kilocode `packages/kilo-memory/`：记忆**既非向量也非 FTS**，是"注入为主
 * + 轻量词典检索兜底"的混合机制，全程零重依赖。本模块只负责**打分/排序/去重**
 * 的纯逻辑（可单测，不碰文件系统），把查过的记忆片段以 top-k 形式返回给调用方
 * （`memory_recall` 工具注入上下文）。
 *
 * 打分 = **查询词元在命中体中的命中计数**（非 BM25 / 非向量）——一个查询词元在
 * 条目里出现（相等或后缀容错前缀）即 +1；排序 = 分数 → 新鲜度 → 字典序；
 * `overlap`/`restates` 去重（高分条目与低分条目词元重叠≥85% 时丢弃后者）；
 * **泛化词剔除**：在 >genericRatio（默认 0.8，且语料 ≥3 条才生效）的条目里都出现
 * 的查询词元视为非判别性，不计分——防止 "memory"/"session" 这类到处都有的词刷
 * 高分数。阈值不能取 kilo 原版的 0.5：AIH 的 memory.md 是**小语料**（个位数到几
 * 十条），领域词 "guardian"/"policy" 出现在 60% 条目里完全正常且极有判别力；
 * 0.8 + 最小语料数下限是「小语料不过度抑制、大语料仍去噪」的平衡点。
 *
 * 词元化（`topics.ts` 等价）：NFKC 归一、camelCase/缩写拆词、小写、CJK 二元组
 * 切分、停用词/单字剔除——中英文通用，纯 stdlib。
 */

/** 检索型记忆条目（调用方从 memory.md 解析后传入）。 */
export interface RecallEntry {
  text: string;
  /** 日期前缀（"2026-08-24"），用于新鲜度排序；缺省 ""。 */
  date?: string;
  /** 来源标记（"project" | "user"），仅用于结果展示。 */
  scope?: string;
}

export interface RecallHit {
  text: string;
  date: string;
  scope?: string;
  /** 命中分数（非泛化查询词元的命中计数）。 */
  score: number;
  /** 命中的查询词元（供展示/调试）。 */
  matched: string[];
}

export interface RecallOptions {
  /** 返回条数上限（默认 8）。 */
  topK?: number;
  /** 最低分数（默认 1，即至少一个非泛化词元命中）。 */
  minScore?: number;
  /** 泛化词阈值：查询词元在 >该比例 的条目里出现即不计分（默认 0.8；仅在语料 ≥MIN_CORPUS_FOR_GENERIC 时生效）。 */
  genericRatio?: number;
  /** restates 去重的词元重叠阈值（默认 0.85）。 */
  restatesThreshold?: number;
}

/**
 * 静态停用词：只放**真正的英文功能词**（the/and/for/...）+ 极少数无义填充词。
 * 领域词（test/build/config/file/state...）**不进**静态表——它们是有意义的判别词，
 * "到处都出现"的非判别性由 `recall()` 的动态 `genericRatio`（>50% 条目出现即不计分）
 * 负责剔除。这样查 "build failure" 仍保留 `build`，而 "memory"/"session" 这类
 * 真正泛滥的词在动态过滤里自然失效。CJK 无静态表（靠二元组 + 动态过滤）。
 */
const STOP = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "these", "those",
  "was", "were", "are", "is", "been", "being", "have", "has", "had", "not", "but",
  "any", "all", "each", "per", "via", "use", "used", "using", "when", "where",
  "while", "after", "before", "then", "than", "onto", "over", "under",
  "more", "most", "less", "least", "some", "such", "only", "also", "just", "very",
  "would", "could", "should", "may", "might", "will", "shall", "can", "need",
  "about", "above", "below", "between", "during", "around", "within", "without",
  "again", "further", "once", "here", "there", "now", "still", "yet", "too",
  "etc", "eg", "ie", "na",
]);

/**
 * 泛化词检测生效的最小语料条数：N<3 时 "出现在 X% 条目里" 没有统计意义
 * （两条同主题记忆 100% 重叠是常态），完全不抑制。
 */
const MIN_CORPUS_FOR_GENERIC = 3;

/** camelCase / AcronymCase → 空格分隔（在 lowercasing 前做，保留边界）。 */function splitCamel(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // fooBar → foo Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // HTTPServer → HTTP Server
}

/** 单字符是否 CJK（统一表意文字 + 扩展 A）。 */
function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
}

/**
 * 词元化：NFKC 归一 → camelCase 拆词 → 小写 → 按连续字母/数字/CJK 切分 →
 * CJK 段切二元组、字母数字段保留整词 → 去停用词/单字/重复。
 * 返回保序去重词元数组（空串输入 → []）。
 */
export function tokenize(text: string): string[] {
  let s = text.normalize("NFKC");
  s = splitCamel(s);
  s = s.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string): void => {
    if (t.length < 2) return; // 单字/单字母噪声
    if (STOP.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const runs = s.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const run of runs) {
    if (Array.from(run).some(isCjk)) {
      const chars = Array.from(run);
      // 只取纯 CJK 子串做二元组；混入的字母数字单独成词
      let buf = "";
      const flush = (): void => { if (buf) add(buf); buf = ""; };
      for (let i = 0; i < chars.length; i += 1) {
        const c = chars[i];
        if (isCjk(c)) {
          flush();
          if (i + 1 < chars.length && isCjk(chars[i + 1])) add(c + chars[i + 1]);
        } else {
          buf += c;
        }
      }
      flush();
    } else {
      add(run);
    }
  }
  return out;
}

/**
 * 词元命中：相等，或一个是另一个的前缀且长度差≤3（后缀容错，对齐 kilo
 * `topics.ts` 的 "前缀重合且长度差≤3"）。两个词都≥2 才比较。
 */
function tokenHit(q: string, e: string): boolean {
  if (q === e) return true;
  if (q.length < 2 || e.length < 2) return false;
  const [a, b] = q.length <= e.length ? [q, e] : [e, q];
  if (!b.startsWith(a)) return false;
  return b.length - a.length <= 3;
}

/**
 * restates 去重：两词元集合中较小者≥阈值比例的词元被较大者覆盖 → 视为重述。
 * 用于丢弃与更高分类别同义的重复条目。
 */
export function restates(a: string[], b: string[], threshold = 0.85): boolean {
  if (!a.length || !b.length) return false;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const inter = small.filter((t) => big.some((g) => g === t || tokenHit(t, g))).length;
  return inter / small.length >= threshold;
}

/**
 * 主入口：按查询词元对语料打分、排序、去重、截断 top-k。
 *
 *  - 每个查询词元先做**泛化词检测**：在 >genericRatio 比例的条目里出现的词元
 *    视为非判别性（不计分），避免 "memory" 这类到处都有的词刷分。
 *  - 分数 = 非泛化查询词元的命中计数。
 *  - 排序 = 分数降序 → date 降序（空 date 视为最旧）→ text 升序（确定性）。
 *  - 去重 = 与已保留的更高分条目 restates（重叠≥阈值）则丢弃。
 *  - 返回 ≤topK 条，分数 < minScore 的丢弃。
 */
export function recall(query: string, corpus: RecallEntry[], opts: RecallOptions = {}): RecallHit[] {
  const topK = opts.topK ?? 8;
  const minScore = opts.minScore ?? 1;
  const genericRatio = opts.genericRatio ?? 0.8;
  const restatesThreshold = opts.restatesThreshold ?? 0.85;

  const qTokens = tokenize(query);
  if (!qTokens.length || corpus.length === 0) return [];

  // Pre-tokenize the corpus once.
  const entryTokens = corpus.map((e) => tokenize(e.text));

  // Generic-word detection per query token: appears in > genericRatio * N entries.
  // Below MIN_CORPUS_FOR_GENERIC entries the corpus is too small for "appears
  // everywhere" to mean anything statistically — no suppression at all.
  const n = corpus.length;
  const genericOn = n >= MIN_CORPUS_FOR_GENERIC;
  const isGeneric = qTokens.map((q) => {
    if (!genericOn) return false;
    let hits = 0;
    for (let i = 0; i < n; i += 1) if (entryTokens[i].some((e) => tokenHit(q, e))) hits += 1;
    return hits / n > genericRatio;
  });

  // Score each entry; record which (non-generic) query tokens hit.
  const scored = corpus.map((entry, i) => {
    const matched: string[] = [];
    let score = 0;
    for (let qi = 0; qi < qTokens.length; qi += 1) {
      if (isGeneric[qi]) continue;
      if (entryTokens[i].some((e) => tokenHit(qTokens[qi], e))) {
        score += 1;
        matched.push(qTokens[qi]);
      }
    }
    return { entry, tokens: entryTokens[i], score, matched };
  });

  // Sort: score desc → date desc → text asc (deterministic tie-break).
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    const dx = x.entry.date ?? "";
    const dy = y.entry.date ?? "";
    if (dx !== dy) return dx < dy ? 1 : -1;
    return x.entry.text < y.entry.text ? -1 : x.entry.text > y.entry.text ? 1 : 0;
  });

  // Dedupe (restates) against already-kept higher-scoring entries, then top-k.
  const kept: RecallHit[] = [];
  for (const s of scored) {
    if (s.score < minScore) continue;
    const dup = kept.some((k) => restates(s.tokens, tokenize(k.text), restatesThreshold));
    if (dup) continue;
    kept.push({
      text: s.entry.text,
      date: s.entry.date ?? "",
      scope: s.entry.scope,
      score: s.score,
      matched: s.matched,
    });
    if (kept.length >= topK) break;
  }
  return kept;
}
