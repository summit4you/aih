#!/usr/bin/env node
/**
 * docs-site check — runs after build; asserts the emitted site is sound:
 *   1. every nav entry produced an HTML file
 *   2. every internal <a href> resolves to a file that exists in dist (no 404)
 *   3. nav ↔ content files are 1:1 (no orphan page, no dangling nav)
 *   4. assets (style.css / app.js) present
 *   5. no page is empty / missing the content mount
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

if (!existsSync(join(DIST, "index.html"))) {
  fail("dist/index.html missing — run `node build.mjs` first");
  process.exit(1);
}

const files = new Set(readdirSync(DIST));
const nav = JSON.parse(readFileSync(join(CONTENT, "_nav.json"), "utf8"));
const toHtml = (h) => {
  const x = h.replace(/^\.\//, "").replace(/\.md$/, "");
  return x === "" || x === "index" ? "index.html" : `${x}.html`;
};

// 1. nav → file
for (const n of nav) {
  const f = toHtml(n.href);
  files.has(f) ? ok(`nav "${n.label}" → ${f}`) : fail(`nav "${n.label}" → ${f} not built`);
}

// 2. internal links resolve
const linkRe = /href="([^"]+)"/g;
for (const f of files) {
  if (!f.endsWith(".html")) continue;
  const html = readFileSync(join(DIST, f), "utf8");
  for (const m of html.matchAll(linkRe)) {
    const href = m[1];
    if (/^(https?:|mailto:|#|data:)/.test(href)) continue;
    const path = href.split("#")[0];
    if (!path) continue; // pure in-page anchor
    // already a concrete file (build rewrites bare names to .html; assets stay literal)
    const target = /\.(html|css|js|svg|png|ico)$/.test(path) ? path : toHtml(path);
    files.has(target) ? ok(`${f} → ${href}`) : fail(`${f} → ${href} (404: ${target} missing)`);
  }
}

// 3. content ↔ nav 1:1
const mdPages = readdirSync(CONTENT)
  .filter((f) => f.endsWith(".md"))
  .map((f) => toHtml(f.replace(/\.md$/, "")));
const navFiles = nav.map((n) => toHtml(n.href));
for (const p of mdPages) if (!navFiles.includes(p)) fail(`orphan content page ${p} (not in nav)`);
for (const n of navFiles) if (!mdPages.includes(n)) fail(`dangling nav ${n} (no content)`);
ok(`nav ↔ content 1:1 (${mdPages.length} pages)`);

// 4. assets
for (const a of ["style.css", "app.js"]) {
  files.has(a) ? ok(`asset ${a}`) : fail(`asset ${a} missing`);
}

// 5. non-empty content mount
for (const f of files) {
  if (!f.endsWith(".html")) continue;
  const html = readFileSync(join(DIST, f), "utf8");
  const m = html.match(/<main[^>]*id="content"[^>]*>([\s\S]*?)<\/main>/);
  if (m && m[1].trim().length > 80) ok(`${f} content mounted (${m[1].trim().length} chars)`);
  else fail(`${f} content mount empty/missing`);
}

console.log(failures === 0 ? "\ndocs-site check: PASS" : `\ndocs-site check: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
