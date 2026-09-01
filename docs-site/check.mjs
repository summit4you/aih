#!/usr/bin/env node
/**
 * docs-site check — runs after build; asserts the emitted site is sound:
 *   1. every nav entry (flat + group children, recursive) produced an HTML file
 *   2. every internal <a href> resolves to a file that exists in dist (no 404)
 *   3. nav ↔ content pages are 1:1 per language (no orphan page, no dangling nav —
 *      recursing into groups and subdirectories)
 *   4. shared assets (style.css / app.js / favicon.svg) present at dist root
 *   5. no page is empty / missing the content mount
 *   6. the language switcher is present on every page
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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

/**
 * Recursively list built html files under a dist language dir, as relative paths.
 * `excludeDirs` are sibling language subdirectories to skip (the zh language's
 * output lives at the dist root and must not swallow the en/ subtree, which is
 * validated under its own language pass).
 */
function listHtml(dir, base = "", excludeDirs = []) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    const rel = base ? `${base}/${f}` : f;
    if (statSync(full).isDirectory()) {
      if (excludeDirs.includes(f)) continue;
      out.push(...listHtml(full, rel, excludeDirs));
    } else if (f.endsWith(".html")) out.push(rel);
  }
  return out;
}

/** Recursively discover content pages (relative page ids, no .md, no _nav). */
function discoverPages(dir, base = "") {
  const out = [];
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    const rel = base ? `${base}/${f}` : f;
    if (statSync(full).isDirectory()) out.push(...discoverPages(full, rel));
    else if (f.endsWith(".md")) out.push(rel.replace(/\.md$/, ""));
  }
  return out;
}

/** Walk the nav tree, returning the list of href entries. */
function navHrefs(nav, acc = []) {
  for (const it of nav) {
    if (it.type === "group") navHrefs(it.children ?? [], acc);
    else acc.push(it.href);
  }
  return acc;
}

for (const lang of LANGS) {
  const outDir = join(DIST, lang.dir);
  // zh (dir="") lives at the root — exclude the sibling en/ subtree.
  const exclude = lang.dir ? [] : ["en"];
  const files = listHtml(outDir, "", exclude);
  const pagesDir = join(CONTENT, lang.code);
  const nav = JSON.parse(readFileSync(join(pagesDir, "_nav.json"), "utf8"));

  // 1. nav → file (all hrefs, recursive)
  const hrefs = navHrefs(nav);
  for (const h of hrefs) {
    const f = toHtml(h);
    files.includes(f) ? ok(`[${lang.code}] nav → ${f}`) : fail(`[${lang.code}] nav "${h}" → ${f} not built`);
  }

  // 3. nav ↔ content 1:1 (recursive, excludes _nav.json which is not a page)
  const mdPages = discoverPages(pagesDir).filter((p) => !p.endsWith("_nav"));
  const navHtml = new Set(hrefs.map(toHtml));
  for (const p of mdPages) {
    if (!navHtml.has(toHtml(p))) fail(`[${lang.code}] orphan content page ${p} (not in nav)`);
  }
  for (const h of new Set(navHtml)) {
    if (!mdPages.map(toHtml).includes(h)) fail(`[${lang.code}] dangling nav ${h} (no content)`);
  }
  ok(`[${lang.code}] nav ↔ content 1:1 (${mdPages.length} pages)`);

  // 2. internal links resolve (relative to the page's own dir)
  const linkRe = /href="([^"]+)"/g;
  for (const f of files) {
    if (!f.endsWith(".html")) continue;
    const html = readFileSync(join(outDir, f), "utf8");
    // resolve relative to the page's directory (nested pages live one deeper)
    const baseDir = dirname(join(outDir, f));
    for (const m of html.matchAll(linkRe)) {
      const href = m[1];
      if (/^(https?:|mailto:|#|data:)/.test(href)) continue;
      const path = href.split("#")[0];
      if (!path) continue; // pure in-page anchor
      const abs = resolve(baseDir, path);
      if (existsSync(abs)) continue;
      fail(`[${lang.code}] ${f} → broken link "${href}"`);
    }
  }

  // 5. non-empty content mount + 6. language switcher
  for (const f of files) {
    const html = readFileSync(join(outDir, f), "utf8");
    const m = html.match(/<main[^>]*id="content"[^>]*>([\s\S]*?)<\/main>/);
    if (m && m[1].trim().length > 80) ok(`[${lang.code}] ${f} content mounted (${m[1].trim().length} chars)`);
    else fail(`[${lang.code}] ${f} content mount empty/missing`);
    if (!/class="lang-switch"/.test(html)) fail(`[${lang.code}] ${f} missing language switcher`);
  }
  ok(`[${lang.code}] language switcher present on all pages`);
}

// 4. shared assets at dist root
for (const a of ["style.css", "app.js", "favicon.svg"]) {
  existsSync(join(DIST, a)) ? ok(`asset ${a}`) : fail(`asset ${a} missing at dist root`);
}
// assets dir (screenshots) present
existsSync(join(DIST, "assets")) ? ok("asset assets/ (screenshots)") : fail("assets/ (screenshots) missing");

console.log(failures === 0 ? "\ndocs-site check: PASS" : `\ndocs-site check: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
