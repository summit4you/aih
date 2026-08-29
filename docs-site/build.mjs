#!/usr/bin/env node
/**
 * AIH docs-site builder — content/*.md → dist/*.html (opencode.ai/docs-style).
 *
 * Zero framework: `marked` renders Markdown, a shared layout + CSS provides the
 * chrome (left nav sidebar, content column, responsive). All internal links are
 * rewritten to RELATIVE paths so the site works on GitHub Pages subpaths
 * (https://<user>.github.io/aih/) without any base-path config.
 *
 * Single source of truth for navigation: content/_nav.json.
 */
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(ROOT, "content");
const DIST = join(ROOT, "dist");

// ---------------------------------------------------------------------------
// Nav (single source of truth)
// ---------------------------------------------------------------------------
const nav = JSON.parse(readFileSync(join(CONTENT, "_nav.json"), "utf8"));

/** href in nav/content links → output html file name */
function toHtml(href) {
  const h = href.replace(/^\.\//, "").replace(/\.md$/, "");
  return h === "" || h === "index" ? "index.html" : `${h}.html`;
}

function renderNav(activeHref) {
  const items = nav
    .map((it) => {
      const href = toHtml(it.href);
      const active = href === toHtml(activeHref) ? " class=\"active\"" : "";
      return `      <a href="${href}"${active}>${it.label}</a>`;
    })
    .join("\n");
  return `    <nav class="sidebar" id="sidebar">
      <a class="brand" href="index.html"><span class="brand-mark">◆</span> AIH <span class="brand-sub">文档</span></a>
${items}
    </nav>`;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------
marked.setOptions({ gfm: true, breaks: false });

/** Rewrite internal links to relative .html; leave external/anchor links alone. */
function relink(html, pageHref) {
  return html.replace(/href="([^"]+)"/g, (m, href) => {
    if (/^(https?:|mailto:|#|data:)/.test(href)) return m;
    // strip anchor
    const [path, anchor] = href.split("#");
    const suffix = anchor ? `#${anchor}` : "";
    if (!path) return `href="${suffix}"`;
    const target = toHtml(path);
    // relative from the current page's directory (all pages live in dist root)
    return `href="${target}${suffix}"`;
  });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const layout = readFileSync(join(ROOT, "layout.html"), "utf8");

const pages = readdirSync(CONTENT)
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));

// every nav entry must have a content file (and vice versa)
const navHrefs = nav.map((n) => toHtml(n.href));
for (const p of pages) {
  const html = toHtml(p);
  if (!navHrefs.includes(html)) {
    throw new Error(`content page "${p}.md" has no entry in _nav.json`);
  }
}
for (const h of navHrefs) {
  if (!pages.map(toHtml).includes(h)) {
    throw new Error(`nav entry "${h}" has no content file`);
  }
}

mkdirSync(DIST, { recursive: true });
const built = [];
for (const page of pages) {
  const md = readFileSync(join(CONTENT, `${page}.md`), "utf8");
  // frontmatter: ---\ntitle: ...\ndescription: ...\n---
  let title = "AIH 文档";
  let description = "AIH — App Intelligence Harness 文档";
  let body = md;
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    body = md.slice(fm[0].length);
    const t = fm[1].match(/^title:\s*(.+)$/m);
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (t) title = t[1].trim();
    if (d) description = d[1].trim();
  }
  const navLabel = nav.find((n) => toHtml(n.href) === toHtml(page));
  if (navLabel) title = `${navLabel.label} · AIH`;
  const html = relink(marked.parse(body), page);
  const out = layout
    .replace("__TITLE__", title)
    .replace("__DESC__", description)
    .replace("__NAV__", renderNav(page))
    .replace("__CONTENT__", html);
  const file = join(DIST, toHtml(page));
  writeFileSync(file, out);
  built.push(toHtml(page));
}

// static assets
cpSync(join(ROOT, "style.css"), join(DIST, "style.css"));
cpSync(join(ROOT, "app.js"), join(DIST, "app.js"));
if (readdirSync(ROOT).includes("favicon.svg")) {
  cpSync(join(ROOT, "favicon.svg"), join(DIST, "favicon.svg"));
}

console.log(`docs-site: built ${built.length} pages → ${relative(process.cwd(), DIST)}/`);
for (const b of built.sort()) console.log(`  ok  ${b}`);
