import * as cheerio from "cheerio";
// Explicit .ts extension: also loaded directly by the unit tests.
import type { Block } from "./structure.ts";

/** Elements that are page chrome or interactive widgets, not content. */
const SKIP = new Set(["script", "style", "noscript", "svg", "iframe", "nav", "footer", "header", "form", "aside", "template", "button", "select", "option", "canvas", "video", "audio", "picture"]);
/** Elements that start a new block of text. */
const BLOCK = new Set(["p", "div", "section", "article", "main", "body", "blockquote", "pre", "dl", "dt", "dd", "figure", "figcaption", "address", "details", "summary", "center", "fieldset", "li", "tr", "td", "th", "hr"]);

const clean = (s: string) => s.replace(/[ \t \r\n]+/g, " ").trim();

/**
 * HTML → blocks in document order: h1–h6 become headings, ul/ol lists, tables rows under their header (the first row
 * when there is no <th>), everything else paragraphs. Navigation, headers, footers and forms are skipped.
 */
export function htmlToBlocks(html: string): { title: string; blocks: Block[] } {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text());
  const root = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body").first();
  const blocks: Block[] = [];
  let buf = "";
  const flush = () => {
    const text = clean(buf);
    if (text) blocks.push({ kind: "text", text });
    buf = "";
  };

  const walk = (node: ReturnType<typeof $>[number]) => {
    if (node.type === "text") {
      buf += (node as unknown as { data: string }).data;
      return;
    }
    if (node.type !== "tag") return;
    const el = node as unknown as { name: string; children: ReturnType<typeof $>[number][] };
    const tag = el.name.toLowerCase();
    if (SKIP.has(tag)) return;
    if (/^h[1-6]$/.test(tag)) {
      flush();
      const text = clean($(node).text());
      if (text) blocks.push({ kind: "heading", level: Number(tag[1]), text });
      return;
    }
    if (tag === "ul" || tag === "ol") {
      flush();
      const items = $(node)
        .children("li")
        .toArray()
        .map((li) => clean($(li).text()))
        .filter(Boolean);
      if (items.length) blocks.push({ kind: "list", items });
      return;
    }
    if (tag === "table") {
      flush();
      const rows = $(node)
        .find("tr")
        .toArray()
        .map((tr) => ({ th: $(tr).children("th").length > 0, cells: $(tr).children("th,td").toArray().map((c) => clean($(c).text())) }))
        .filter((r) => r.cells.some(Boolean));
      if (!rows.length) return;
      const headerRow = rows[0];
      if (rows.length === 1) blocks.push({ kind: "text", text: headerRow.cells.join(" · ") });
      else blocks.push({ kind: "table", header: headerRow.cells, rows: rows.slice(1).map((r) => r.cells) });
      return;
    }
    if (tag === "br") {
      buf += "\n";
      return;
    }
    const isBlock = BLOCK.has(tag);
    if (isBlock) flush();
    for (const child of el.children) walk(child);
    if (isBlock) flush();
  };

  for (const child of root.toArray()) walk(child);
  flush();
  return { title, blocks };
}
