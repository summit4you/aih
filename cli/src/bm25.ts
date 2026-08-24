/**
 * P1#4 — BM25 relevance scoring for skill auto-loading.
 *
 * Pure, dependency-free Okapi BM25 over a small corpus (skill name +
 * description + body). Used to rank installed skills against a user query so
 * the harness can surface / auto-load the most relevant skill instead of
 * relying only on explicit `load_skill` calls. No LLM, fully unit-testable.
 */

export interface Bm25Doc {
  id: string;
  /** the text to index (name + description + body) */
  text: string;
}

export interface Bm25Index {
  k1: number;
  b: number;
  df: Map<string, number>;
  avgdl: number;
  docs: Array<{ id: string; tf: Map<string, number>; dl: number }>;
}

const K1 = 1.5;
const B = 0.75;

/**
 * Tokenize for BM25. ASCII runs become single tokens; CJK runs (no word
 * boundaries) are expanded into character bigrams — the standard segmenter-free
 * CJK IR technique — so a substring query like "批量操作" matches a longer run
 * like "批量操作与验证". A lone CJK character is kept as-is.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  const re = /[a-z0-9]+|[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    const tok = m[0];
    if (/^[a-z0-9]+$/.test(tok)) {
      out.push(tok);
      continue;
    }
    // CJK run: emit bigrams (or the single char for length-1 runs).
    if (tok.length === 1) {
      out.push(tok);
    } else {
      for (let i = 0; i < tok.length - 1; i += 1) out.push(tok.slice(i, i + 2));
    }
  }
  return out;
}

/** Build a BM25 index over the given documents. */
export function buildIndex(docs: Bm25Doc[], k1 = K1, b = B): Bm25Index {
  const df = new Map<string, number>();
  const indexed = docs.map((d) => {
    const tokens = tokenize(d.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: d.id, tf, dl: tokens.length };
  });
  for (const doc of indexed) {
    for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const totalLen = indexed.reduce((n, d) => n + d.dl, 0);
  return { k1, b, df, avgdl: indexed.length ? totalLen / indexed.length : 0, docs: indexed };
}

/** BM25 score of a single document against the query terms. */
function scoreDoc(doc: Bm25Index["docs"][number], terms: string[], idx: Bm25Index): number {
  let score = 0;
  for (const term of terms) {
    const f = doc.tf.get(term);
    if (!f) continue;
    const df = idx.df.get(term) ?? 0;
    const n = idx.docs.length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    const denom = f + idx.k1 * (1 - idx.b + idx.b * (doc.dl / (idx.avgdl || 1)));
    score += idf * ((f * (idx.k1 + 1)) / denom);
  }
  return score;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

/** Rank the indexed documents against a query; return hits with score > 0. */
export function search(index: Bm25Index, query: string, topK = 10): Bm25Hit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const hits = index.docs
    .map((d) => ({ id: d.id, score: scoreDoc(d, terms, index) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/**
 * Convenience: index + rank in one call. Returns the top-k doc ids (highest
 * score first) that match the query.
 */
export function rank(docs: Bm25Doc[], query: string, topK = 10): Bm25Hit[] {
  return search(buildIndex(docs), query, topK);
}
