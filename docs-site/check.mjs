#!/usr/bin/env node
/**
 * docs-site check — runs after build; asserts the emitted site is sound:
 *   1. every nav entry produced an HTML file (per language)
 *   2. every internal <a href> resolves to a file that exists in dist (no 404)
 *   3. nav ↔ content files are 1:1 per language (no orphan page, no dangling nav)
 *   4. shared assets (style.css / app.js / favicon.svg) present at dist root
 *   5. no page is empty / missing the content mount
 *   6. the language switcher is present on every page
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
const CONTENT = join(ROOT, "content");

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};

const LANGS = [
  { code: "zh", dir: "" },
  { code: "en", dir: "en" },
];

const toHtml = (h) => {
  const x = h.replace(/^\.\//, "").replace(/\.md$/, "");
  return x === "" || x === "index" ? "index.html" : `${x}.html`;
};

if (!existsSync(join(DIST, "index.html"))) {
  fail("dist/index.html missing — run `node build.mjs` first");
  process.exit(1);
}

const distFiles = new Set(readdirSync(DIST));
// en files live under dist/en/
const enFiles = new Set(existsSync(join(DIST, "en")) ? readdirSync(join(DIST, "en")) : []);

for (const lang of LANGS) {
  const files = lang.dir ? enFiles : distFiles;
  const pagesDir = join(CONTENT, lang.code);
  const nav = JSON.parse(readFileSync(join(pagesDir, "_nav.json"), "utf8"));

  // 1. nav → file
  for (const n of nav) {
    const f = toHtml(n.href);
    files.has(f) ? ok(`[${lang.code}] nav "${n.label}" → ${f}`) : fail(`[${lang.code}] nav "${n.label}" → ${f} not built`);
  }

  // 3. nav ↔ content 1:1
  const mdPages = readdirSync(pagesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => toHtml(f.replace(/\.md$/, "")));
  const navFiles = nav.map((n) => toHtml(n.href));
  for (const p of mdPages) if (!navFiles.includes(p)) fail(`[${lang.code}] orphan content page ${p} (not in nav)`);
  for (const n of navFiles) if (!mdPages.includes(n)) fail(`[${lang.code}] dangling nav ${n} (no content)`);
  ok(`[${lang.code}] nav ↔ content 1:1 (${mdPages.length} pages)`);

  // 2. internal links resolve (relative to the page's own dir)
  const linkRe = /href="([^"]+)"/g;
  for (const f of files) {
    if (!f.endsWith(".html")) continue;
    const html = readFileSync(join(DIST, lang.dir, f), "utf8");
    for (const m of html.matchAll(linkRe)) {
      const href = m[1];
      if (/^(https?:|mailto:|#|data:)/.test(href)) continue;
      const path = href.split("#")[0];
      if (!path) continue; // pure in-page anchor
      const abs = resolve(join(DIST, lang.dir), path);
      if (existsSync(abs)) continue;
      fail(`[${lang.code}] ${f} → broken link "${href}"`);
    }
  }

  // 5. non-empty content mount + 6. language switcher
  for (const f of files) {
    if (!f.endsWith(".html")) continue;
    const html = readFileSync(join(DIST, lang.dir, f), "utf8");
    const m = html.match(/<main[^>]*id="content"[^>]*>([\s\S]*?)<\/main>/);
    if (m && m[1].trim().length > 80) ok(`[${lang.code}] ${f} content mounted (${m[1].trim().length} chars)`);
    else fail(`[${lang.code}] ${f} content mount empty/missing`);
    if (!/class="lang-switch"/.test(html)) fail(`[${lang.code}] ${f} missing language switcher`);
  }
  ok(`[${lang.code}] language switcher present on all pages`);
}

// 4. shared assets at dist root
for (const a of ["style.css", "app.js", "favicon.svg"]) {
  distFiles.has(a) ? ok(`asset ${a}`) : fail(`asset ${a} missing at dist root`);
}
// assets dir (screenshots) present
if (distFiles.has("assets")) ok("asset assets/ (screenshots)");
else fail("assets/ (screenshots) missing");

console.log(failures === 0 ? "\ndocs-site check: PASS" : `\ndocs-site check: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
