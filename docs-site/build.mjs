#!/usr/bin/env node
/**
 * AIH docs-site builder — content/{zh,en}/*.md → dist/ (opencode.ai/docs-style).
 *
 * Zero framework: `marked` renders Markdown, a shared layout + CSS provides the
 * chrome (left nav sidebar, content column, responsive, i18n switcher).
 *
 * i18n layout (all internal links RELATIVE → works on GitHub Pages subpath
 * https://<user>.github.io/aih/ without base-path config):
 *   dist/index.html, install.html, ...   ← Chinese (default, keeps old URLs)
 *   dist/en/index.html, en/install.html  ← English
 *   dist/style.css, app.js, favicon.svg, assets/   ← shared assets (root)
 *
 * Single source of truth per language: content/<lang>/_nav.json.
 */
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(ROOT, "content");
const DIST = join(ROOT, "dist");

marked.setOptions({ gfm: true, breaks: false });

/** Languages to build. `dir` is the dist subdirectory ("" = root). */
const LANGS = [
  { code: "zh", dir: "", switchTo: { href: "en/index.html", label: "English" } },
  { code: "en", dir: "en", switchTo: { href: "../index.html", label: "中文" } },
];

/** href in nav/content links → output html file name */
function toHtml(href) {
  const h = href.replace(/^\.\//, "").replace(/\.md$/, "");
  return h === "" || h === "index" ? "index.html" : `${h}.html`;
}

function renderNav(activeHref, lang) {
  const navPath = join(CONTENT, lang.code, "_nav.json");
  const nav = JSON.parse(readFileSync(navPath, "utf8"));
  const items = nav
    .map((it) => {
      const href = toHtml(it.href);
      const active = href === toHtml(activeHref) ? ' class="active"' : "";
      return `      <a href="${href}"${active}>${it.label}</a>`;
    })
    .join("\n");
  const sw = lang.switchTo;
  return `    <nav class="sidebar" id="sidebar">
      <a class="brand" href="index.html"><span class="brand-mark">◆</span> AIH <span class="brand-sub">${lang.code === "zh" ? "文档" : "Docs"}</span></a>
${items}
      <div class="nav-lang">
        <span class="nav-lang-label">${lang.code === "zh" ? "语言" : "Language"}</span>
        <a class="lang-switch" href="${sw.href}">${sw.label} →</a>
      </div>
    </nav>`;
}

/** Rewrite internal links to relative .html; leave external/anchor links alone. */
function relink(html, pageHref) {
  return html.replace(/href="([^"]+)"/g, (m, href) => {
    if (/^(https?:|mailto:|#|data:)/.test(href)) return m;
    const [path, anchor] = href.split("#");
    const suffix = anchor ? `#${anchor}` : "";
    if (!path) return `href="${suffix}"`;
    const target = toHtml(path);
    return `href="${target}${suffix}"`;
  });
}

function parseFrontmatter(md) {
  let title = "AIH";
  let description = "AIH — App Intelligence Harness";
  let body = md;
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    body = md.slice(fm[0].length);
    const t = fm[1].match(/^title:\s*(.+)$/m);
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (t) title = t[1].trim();
    if (d) description = d[1].trim();
  }
  return { title, description, body };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const layout = readFileSync(join(ROOT, "layout.html"), "utf8");

const built = [];
for (const lang of LANGS) {
  const outDir = join(DIST, lang.dir);
  mkdirSync(outDir, { recursive: true });

  const pagesDir = join(CONTENT, lang.code);
  const pages = readdirSync(pagesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));

  const nav = JSON.parse(readFileSync(join(pagesDir, "_nav.json"), "utf8"));
  const navHrefs = nav.map((n) => toHtml(n.href));

  // every nav entry must have a content file (and vice versa)
  for (const p of pages) {
    const html = toHtml(p);
    if (!navHrefs.includes(html)) {
      throw new Error(`[${lang.code}] content page "${p}.md" has no entry in _nav.json`);
    }
  }
  for (const h of navHrefs) {
    if (!pages.map(toHtml).includes(h)) {
      throw new Error(`[${lang.code}] nav entry "${h}" has no content file`);
    }
  }

  for (const page of pages) {
    const md = readFileSync(join(pagesDir, `${page}.md`), "utf8");
    const fm = parseFrontmatter(md);
    let title = fm.title;
    const { description, body } = fm;
    const navLabel = nav.find((n) => toHtml(n.href) === toHtml(page));
    if (navLabel) title = `${navLabel.label} · AIH`;
    let html = relink(marked.parse(body), page);
    const assetPrefix = lang.dir ? "../" : "";
    // images referenced from content markdown (e.g. <img src="assets/x.png">)
    // must reach the shared dist/assets/ from the language dir.
    if (assetPrefix) html = html.replaceAll('src="assets/', `src="${assetPrefix}assets/`);
    const out = layout
      .replace("__LANG__", lang.code === "zh" ? "zh-CN" : "en")
      .replaceAll("__ASSET__", assetPrefix)
      .replace("__TITLE__", title)
      .replace("__DESC__", description)
      .replace("__NAV__", renderNav(page, lang))
      .replace("__CONTENT__", html);
    const file = toHtml(page);
    writeFileSync(join(outDir, file), out);
    built.push(`${lang.dir ? lang.dir + "/" : ""}${file}`);
  }
}

// shared assets → dist root (en pages reference them via ../)
if (existsSync(join(ROOT, "style.css"))) cpSync(join(ROOT, "style.css"), join(DIST, "style.css"));
if (existsSync(join(ROOT, "app.js"))) cpSync(join(ROOT, "app.js"), join(DIST, "app.js"));
if (existsSync(join(ROOT, "favicon.svg"))) cpSync(join(ROOT, "favicon.svg"), join(DIST, "favicon.svg"));
if (existsSync(join(ROOT, "assets"))) cpSync(join(ROOT, "assets"), join(DIST, "assets"), { recursive: true });

console.log(`docs-site: built ${built.length} pages (${LANGS.map((l) => l.code).join(" + ")}) → ${relative(process.cwd(), DIST)}/`);
for (const b of built.sort()) console.log(`  ok  ${b}`);
