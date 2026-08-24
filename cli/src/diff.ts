export interface DiffLine {
  t: "add" | "del";
  s: string;
  /** 1-based line number in the old file (present on del lines). */
  a?: number;
  /** 1-based line number in the new file (present on add lines). */
  b?: number;
}

const MAX_DIFF_LINES = 80;
const MAX_LCS_CELLS = 250_000;

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length === b.length && a.every((l, i) => l === b[i])) return [];
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((s, k): DiffLine => ({ t: "del", s, a: k + 1 })),
      ...b.map((s, k): DiffLine => ({ t: "add", s, b: k + 1 })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: "del", s: a[i], a: i + 1 });
      i += 1;
    } else {
      out.push({ t: "add", s: b[j], b: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ t: "del", s: a[i], a: i + 1 });
    i += 1;
  }
  while (j < m) {
    out.push({ t: "add", s: b[j], b: j + 1 });
    j += 1;
  }
  return out;
}

export function capDiff(d: DiffLine[]): { lines: DiffLine[]; truncated: number } {
  if (d.length <= MAX_DIFF_LINES) return { lines: d, truncated: 0 };
  const head = Math.ceil(MAX_DIFF_LINES / 2);
  const tail = MAX_DIFF_LINES - head;
  return { lines: [...d.slice(0, head), ...d.slice(d.length - tail)], truncated: d.length - MAX_DIFF_LINES };
}
