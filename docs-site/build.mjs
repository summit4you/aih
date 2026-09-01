#!/usr/bin/env node
/**
 * AIH docs-site builder — content/{zh,en}/**\/*.md → dist/ (opencode.ai/docs-style).
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
 *
 * NAV MODEL (v2 — grouped):
 *   _nav.json is a list of entries; each entry is either
 *     { "href": "page", "label": "..." }          → a flat link (default)
 *   or
 *     { "type": "group", "label": "...", "children": [ ... ] }
 *                                                → a collapsible section that
 *                                                  renders a heading then its
 *                                                  children (which may
 *                                                  themselves be groups).
 *   Flat entries are validated 1:1 against content pages; group children that
 *   are href entries must also resolve to a content page (recursively).
 *   The tutorial book lives under content/<lang>/tutorial/*.md and is attached
 *   to the sidebar as a "教程 / Tutorial" group whose children are the five
 *   Part sub-groups, each holding its chapters.
 */
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, existsSync, statSync } from "node:fs";
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

/** href in nav/content links → output html file name (keeps directories) */
function toHtml(href) {
  const h = href.replace(/^\.\//, "").replace(/\.md$/, "");
  return h === "" || h === "index" ? "index.html" : `${h}.html`;
}

/** Recursively discover content pages (*.md, excluding _nav.json) under a dir. */
function discoverPages(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) {
      out.push(...discoverPages(full));
    } else if (f.endsWith(".md")) {
      // "chapter01.md" → "tutorial/chapter01"  (a slash-friendly page id)
      const relPath = relative(CONTENT, full).replace(/\.md$/, "");
      const [lang, ...rest] = relPath.split("/");
      if (!lang) continue;
      out.push(rest.join("/"));
    }
  }
  return out;
}

/**
 * Render one nav level. `activeHref` is the html filename of the current page.
 * Entries with `href` become links; entries with `type:"group"` render a
 * section heading + their children. Indentation reflects nesting depth.
 */
function renderNavLevel(nav, activeHref, lang, depth, relPrefix) {
  const out = [];
  for (const it of nav) {
    if (it.type === "group") {
      const kids = renderNavLevel(it.children ?? [], activeHref, lang, depth + 1, relPrefix);
      if (!kids.trim()) continue;
      const cls = depth === 0 ? "nav-group" : "nav-subgroup";
      out.push(`      <div class="${cls}">
        <span class="nav-group-label">${it.label}</span>
${kids.trim()}
      </div>`);
    } else {
      const href = `${relPrefix}${toHtml(it.href)}`;
      const active = href === `${relPrefix}${toHtml(activeHref)}` ? ' class="active"' : "";
      out.push(`      <a href="${href}"${active}>${it.label}</a>`);
    }
  }
  return out.join("\n");
}

function renderNav(activeHref, lang) {
  const navPath = join(CONTENT, lang.code, "_nav.json");
  const nav = JSON.parse(readFileSync(navPath, "utf8"));
  // Nav links must resolve relative to the current page's OUTPUT location.
  // A page at depth d (dir segments under the language root) needs d "../" hops
  // back to the language root where the shared nav targets live.
  const depth = Math.max(0, activeHref.split("/").length - 1);
  const relPrefix = "../".repeat(Math.max(0, depth));
  const items = renderNavLevel(nav, activeHref, lang, 0, relPrefix);
  const sw = lang.switchTo;
  const brand = `${relPrefix}index.html`;
  const swHref = `${relPrefix}${sw.href}`;
  return `    <nav class="sidebar" id="sidebar">
      <a class="brand" href="${brand}"><span class="brand-mark">◆</span> AIH <span class="brand-sub">${lang.code === "zh" ? "文档" : "Docs"}</span></a>
${items}
      <div class="nav-lang">
        <span class="nav-lang-label">${lang.code === "zh" ? "语言" : "Language"}</span>
        <a class="lang-switch" href="${swHref}">${sw.label} →</a>
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

/** Build a lookup: pageId (html form) → nav label, walking groups recursively. */
function collectNavLabels(nav, acc = {}) {
  for (const it of nav) {
    if (it.type === "group") collectNavLabels(it.children ?? [], acc);
    else acc[toHtml(it.href)] = it.label;
  }
  return acc;
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
  const pages = discoverPages(pagesDir);
  const nav = JSON.parse(readFileSync(join(pagesDir, "_nav.json"), "utf8"));
  const navLabels = collectNavLabels(nav);

  // every href nav entry (flat + inside groups, recursive) must have a page
  const walkHrefs = (navList) => {
    for (const it of navList) {
      if (it.type === "group") walkHrefs(it.children ?? []);
      else if (it.href) {
        const html = toHtml(it.href);
        if (!pages.map(toHtml).includes(html)) {
          throw new Error(`[${lang.code}] nav entry "${it.label}" (${html}) has no content file`);
        }
      }
    }
  };
  walkHrefs(nav);

  // every page must be reachable from the nav
  for (const p of pages) {
    const html = toHtml(p);
    if (!navLabels[html]) {
      throw new Error(`[${lang.code}] content page "${p}.md" has no entry in _nav.json`);
    }
  }

  for (const page of pages) {
    const md = readFileSync(join(pagesDir, `${page}.md`), "utf8");
    const fm = parseFrontmatter(md);
    let title = fm.title;
    const { description, body } = fm;
    const navLabel = navLabels[toHtml(page)];
    if (navLabel) title = `${navLabel} · AIH`;
    let html = relink(marked.parse(body), page);
    const depth = page.split("/").length - 1;
    // __ASSET__ must reach the shared dist root (style.css / app.js / favicon.svg)
    // from the page's own output dir: depth hops + one more if inside en/.
    const assetPrefix = "../".repeat(depth + (lang.dir ? 1 : 0));
    // images referenced from content markdown (e.g. <img src="assets/x.png">)
    // must reach the shared dist/assets/ from the language dir. Nested pages
    // (tutorial/ch03) live one dir deeper, so reach it via ../assets/ too.
    const relAssets = assetPrefix;
    html = html.replaceAll('src="assets/', `src="${relAssets}assets/`);
    const out = layout
      .replace("__LANG__", lang.code === "zh" ? "zh-CN" : "en")
      .replaceAll("__ASSET__", assetPrefix)
      .replace("__TITLE__", title)
      .replace("__DESC__", description)
      .replace("__NAV__", renderNav(page, lang))
      .replace("__CONTENT__", html);
    const file = toHtml(page);
    const fileDir = dirname(join(outDir, file));
    mkdirSync(fileDir, { recursive: true });
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
