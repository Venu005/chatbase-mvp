import fs from "node:fs";
import path from "node:path";
import { Marked, type Token, type Tokens } from "marked";

/**
 * The docs site's content: the Markdown files in the repository's /docs folder, in the order and sections listed in
 * docs/site.json. Everything is read at build time (pages are static). Links between Markdown files become site links,
 * links to other repository files go to GitHub, and images in docs/guide/img are served from /img.
 */

export const DOCS_DIR = path.resolve(process.cwd(), "../../docs");

type SiteFile = { title: string; repo: string; sections: { title: string; pages: { file: string; slug: string; label?: string }[] }[] };
export type TocItem = { id: string; text: string; level: number };
export type Page = {
  slug: string;
  file: string;
  section: string;
  title: string;
  description: string;
  html: string;
  toc: TocItem[];
};
export type SearchEntry = { slug: string; page: string; heading: string; anchor: string; text: string };
export type NavSection = { title: string; pages: { slug: string; title: string }[] };

export const site = (): SiteFile => JSON.parse(fs.readFileSync(path.join(DOCS_DIR, "site.json"), "utf8"));

/** GitHub-style heading anchors, so links like setup.md#4-configuration-reference keep working. */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

/** Markdown inline syntax → plain text (for anchors, the table of contents and search). */
export const plain = (s: string) =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function fileMap(s: SiteFile): Map<string, string> {
  return new Map(s.sections.flatMap((sec) => sec.pages.map((p) => [p.file, p.slug] as const)));
}

/** A link written in a Markdown file → where it points on the site. */
export function resolveHref(href: string, fromFile: string, files: Map<string, string>, repo: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const [p, hash] = href.split("#");
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), p));
  const slug = files.get(target);
  if (slug !== undefined) return `/${slug}${hash ? `#${hash}` : ""}`;
  // Any other repository file (README, .env.example, source code): show it on GitHub.
  const repoPath = target.startsWith("../") ? target.replace(/^(\.\.\/)+/, "") : `docs/${target}`;
  return `${repo}/blob/main/${repoPath}${hash ? `#${hash}` : ""}`;
}

export function resolveImage(src: string, fromFile: string): string {
  if (/^[a-z]+:/i.test(src) || src.startsWith("/")) return src;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), src));
  return target.startsWith("guide/img/") ? `/img/${target.slice("guide/img/".length)}` : src;
}

function render(md: string, file: string, s: SiteFile, files: Map<string, string>) {
  const toc: TocItem[] = [];
  const used = new Map<string, number>();
  const anchor = (text: string) => {
    const base = slugify(text) || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Token[]): string } }, { tokens, depth, text }: Tokens.Heading) {
        const label = plain(text);
        const id = anchor(label);
        if (depth === 2 || depth === 3) toc.push({ id, text: label, level: depth });
        const inner = this.parser.parseInline(tokens);
        return depth === 1
          ? `<h1 id="${id}">${inner}</h1>\n`
          : `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      link(this: { parser: { parseInline(t: Token[]): string } }, { href, title, tokens }: Tokens.Link) {
        const to = resolveHref(href, file, files, s.repo);
        const external = /^https?:/i.test(to);
        return `<a href="${escapeAttr(to)}"${title ? ` title="${escapeAttr(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, text }: Tokens.Image) {
        return `<figure><img src="${escapeAttr(resolveImage(href, file))}" alt="${escapeAttr(text)}" loading="lazy"><figcaption>${escapeAttr(text)}</figcaption></figure>`;
      },
      table(this: { parser: unknown }, token: Tokens.Table) {
        // Default rendering, wrapped so wide tables scroll on phones instead of widening the page.
        const header = token.header.map((c, i) => `<th${token.align[i] ? ` style="text-align:${token.align[i]}"` : ""}>${marked.parseInline(c.text)}</th>`).join("");
        const rows = token.rows
          .map((r) => `<tr>${r.map((c, i) => `<td${token.align[i] ? ` style="text-align:${token.align[i]}"` : ""}>${marked.parseInline(c.text)}</td>`).join("")}</tr>`)
          .join("");
        return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  // A Markdown image on its own line is a figure, not a paragraph.
  const html = (marked.parse(md, { async: false }) as string).replace(/<p>(<figure>[\s\S]*?<\/figure>)<\/p>/g, "$1");
  return { html, toc };
}

let cache: { pages: Page[]; search: SearchEntry[] } | null = null;

/** All pages (cached in production; re-read on every request in development so edits show at once). */
export function load(): { pages: Page[]; search: SearchEntry[] } {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const s = site();
  const files = fileMap(s);
  const pages: Page[] = [];
  const search: SearchEntry[] = [];
  for (const sec of s.sections) {
    for (const p of sec.pages) {
      const md = fs.readFileSync(path.join(DOCS_DIR, p.file), "utf8");
      const tokens = new Marked({ gfm: true }).lexer(md);
      const h1 = tokens.find((t): t is Tokens.Heading => t.type === "heading" && t.depth === 1);
      const title = h1 ? plain(h1.text) : p.slug;
      const firstPara = tokens.find((t): t is Tokens.Paragraph => t.type === "paragraph" && !/^\*\*Where:?\*\*/.test(t.text));
      const { html, toc } = render(md, p.file, s, files);
      pages.push({ slug: p.slug, file: p.file, section: sec.title, title, description: firstPara ? plain(firstPara.text).slice(0, 200) : "", html, toc });

      // Search: one entry per heading, with the text under it.
      const used = new Map<string, number>();
      let cur: SearchEntry = { slug: p.slug, page: title, heading: title, anchor: "", text: "" };
      const flush = () => cur.text.trim() || cur.heading !== title ? search.push({ ...cur, text: cur.text.trim().slice(0, 600) }) : undefined;
      for (const t of tokens) {
        if (t.type === "heading") {
          const label = plain((t as Tokens.Heading).text);
          const base = slugify(label) || "section";
          const n = used.get(base) ?? 0;
          used.set(base, n + 1);
          if ((t as Tokens.Heading).depth === 1) continue;
          flush();
          cur = { slug: p.slug, page: title, heading: label, anchor: n ? `${base}-${n}` : base, text: "" };
        } else if (t.type !== "code" && t.type !== "html" && ("text" in t || t.type === "table" || t.type === "list")) {
          const raw = t.type === "table" ? (t as Tokens.Table).rows.map((r) => r.map((c) => c.text).join(" ")).join(" ") : t.raw;
          cur.text += ` ${plain(raw)}`;
        }
      }
      flush();
    }
  }
  cache = { pages, search };
  return cache;
}

export function nav(): NavSection[] {
  const { pages } = load();
  return site().sections.map((sec) => ({
    title: sec.title,
    pages: sec.pages.map((p) => ({ slug: p.slug, title: p.label ?? pages.find((x) => x.slug === p.slug)!.title })),
  }));
}
