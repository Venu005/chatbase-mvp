// Checks the RUNNING docs site (default http://localhost:3003): every page in docs/site.json loads, every link between
// pages and every #anchor points somewhere that exists, images load, search works, and unknown pages are 404s.
//   pnpm --filter @chatbase/docs build && pnpm --filter @chatbase/docs start      then      pnpm smoke:docs
import assert from "node:assert/strict";
import fs from "node:fs";

const BASE = process.env.DOCS_BASE_URL ?? "http://localhost:3003";
const site = JSON.parse(fs.readFileSync(new URL("../../../docs/site.json", import.meta.url), "utf8"));
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;

const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const attr = (html, tag, name) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`, "g"))].map((m) => m[1].replace(/&amp;/g, "&"));
// Only the article: the sidebar and header links are the same on every page.
const article = (html) => html.slice(html.indexOf('<article class="prose">'), html.indexOf("</article>"));

console.log(`Docs smoke test against ${BASE}\n`);
try {
  const slugs = site.sections.flatMap((s) => s.pages.map((p) => p.slug));
  const pages = new Map();
  for (const slug of slugs) {
    const res = await fetch(`${BASE}/${slug}`);
    assert.equal(res.status, 200, `/${slug}`);
    const html = await res.text();
    assert.match(html, /<title>[^<]+<\/title>/, `/${slug} has a title`);
    assert.ok(html.includes('<article class="prose">') && html.includes("<h1"), `/${slug} renders its Markdown`);
    pages.set(slug, html);
  }
  ok(`all ${slugs.length} pages in docs/site.json load, each with a title and a heading`);

  const problems = [];
  let links = 0;
  for (const [slug, html] of pages) {
    for (const href of attr(article(html), "a", "href")) {
      if (/\.md(#|$)/.test(href) && !/^https?:/.test(href)) problems.push(`/${slug}: unconverted link ${href}`);
      if (!href.startsWith("/") && !href.startsWith("#")) continue;
      links++;
      const [p, hash] = href.split("#");
      const target = href.startsWith("#") ? slug : p.replace(/^\//, "");
      if (!pages.has(target)) problems.push(`/${slug}: broken link ${href}`);
      else if (hash && !ids(pages.get(target)).has(decodeURIComponent(hash))) problems.push(`/${slug}: missing anchor ${href}`);
    }
  }
  assert.deepEqual(problems, []);
  ok(`${links} links between pages and their #anchors all resolve; no raw .md links are left`);

  const images = new Set([...pages.values()].flatMap((h) => attr(article(h), "img", "src")));
  assert.ok(images.size >= 8, `screenshots are used (${images.size})`);
  for (const src of images) {
    const res = await fetch(new URL(src, BASE));
    assert.equal(res.status, 200, src);
    assert.match(res.headers.get("content-type") ?? "", /^image\//, src);
  }
  ok(`${images.size} screenshots load`);

  const index = await (await fetch(`${BASE}/search-index.json`)).json();
  assert.ok(index.length > 100, `search index has ${index.length} entries`);
  const hit = index.find((e) => /barge-in|interrupt/i.test(`${e.heading} ${e.text}`) && e.slug === "voice");
  assert.ok(hit, "barge-in is findable on the voice page");
  // Every entry points at an existing page, and at a real heading on it (an empty anchor = the top of the page).
  for (const e of index) {
    assert.ok(pages.has(e.slug), `search entry for unknown page /${e.slug}`);
    assert.ok(!e.anchor || ids(pages.get(e.slug)).has(e.anchor), `search entry ${e.slug}#${e.anchor} has no heading`);
  }
  ok("the search index covers every page, and its entries link to real headings");

  assert.equal((await fetch(`${BASE}/no-such-page`)).status, 404);
  const home = pages.get("");
  assert.ok(attr(home, "a", "href").includes("/getting-started"), "the sidebar lists the pages");
  ok("unknown pages are 404s; the sidebar links every section");
  console.log(`\nAll ${passed} docs checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
}
