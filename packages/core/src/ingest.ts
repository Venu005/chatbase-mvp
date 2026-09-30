import dns from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";
import { getDocumentProxy } from "unpdf";
import { createHash } from "node:crypto";
import { q, toVector, tx } from "./db";
import { chunkText, normalizeText } from "./chunk";
import { chunkBlocks, pagesToBlocks, textToBlocks, type Block } from "./structure";
import { htmlToBlocks } from "./html-blocks";
import { looksClientRendered } from "./content-checks";
export { looksScanned } from "./content-checks";
import { env, envNum } from "./env";
import { embedAll, embeddingModelId, getEmbedder } from "./providers";
import { recordIngest } from "./ai-log";

/** One document of a source. `blocks` keeps its structure (headings, lists, tables, pages); without it `text` is parsed. */
export type Doc = { title: string; url: string | null; text: string; blocks?: Block[] };

/** Plain text of blocks (for size checks and scan/JS detection). */
export function blocksText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.kind === "list" ? b.items.join("\n") : b.kind === "table" ? [b.header, ...b.rows].map((r) => r.join(" ")).join("\n") : b.text))
    .join("\n");
}

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;
export const MAX_CRAWL_PAGES = 20;

// ---------------------------------------------------------------------------
// SSRF protection: users give us URLs and our server fetches them, so we must
// refuse loopback / private / link-local addresses (e.g. cloud metadata at
// 169.254.169.254). Known limitation: DNS could change between this check and
// the actual connection (DNS rebinding). In production, also route fetches
// through an egress proxy that blocks internal ranges.
// ---------------------------------------------------------------------------
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      a >= 224
    );
  }
  const l = ip.toLowerCase();
  const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http/https URLs are allowed");
  if (process.env.ALLOW_PRIVATE_URLS === "true") return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new Error("That address is not allowed");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("Could not resolve that hostname");
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("That address is not allowed");
  return url;
}

async function readLimited(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Page is too large (limit 3 MB)");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function safeFetch(rawUrl: string): Promise<{ url: URL; contentType: string; body: Buffer }> {
  let url = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "ChatbaseIndiaBot/0.1 (+knowledge-base crawler)", accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("Bad redirect");
      url = await assertPublicUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`Fetching ${url.href} failed with HTTP ${res.status}`);
    return { url, contentType: (res.headers.get("content-type") ?? "").toLowerCase(), body: await readLimited(res) };
  }
  throw new Error("Too many redirects");
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------
export function htmlToDoc(html: string, pageUrl: URL): { doc: Doc; links: string[] } {
  const $ = cheerio.load(html);
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    try {
      const u = new URL($(el).attr("href")!, pageUrl);
      u.hash = "";
      if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname === pageUrl.hostname && !/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|css|js|xml|ico)$/i.test(u.pathname)) {
        links.add(u.href);
      }
    } catch {
      /* ignore bad hrefs */
    }
  });
  const { title, blocks } = htmlToBlocks(html);
  return { doc: { title: title || pageUrl.href, url: pageUrl.href, text: blocksText(blocks), blocks }, links: [...links] };
}

export async function pdfToText(buf: Uint8Array): Promise<string> {
  return (await pdfText(buf)).text;
}

/** A PDF's text, page by page as blocks (page numbers kept, running headers and footers dropped). */
export async function pdfText(buf: Uint8Array): Promise<{ text: string; pages: number; blocks: Block[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) pages.push(pageLines((await (await pdf.getPage(i)).getTextContent()).items));
  const blocks = pagesToBlocks(pages);
  return { text: normalizeText(pages.join("\n\n")), pages: pdf.numPages, blocks };
}

/** A page's text items → lines: a new line wherever the PDF ends one or the text moves to another baseline. */
function pageLines(items: unknown[]): string {
  let out = "";
  let lastY: number | null = null;
  for (const it of items as { str?: string; hasEOL?: boolean; transform?: number[]; height?: number }[]) {
    if (typeof it.str !== "string") continue;
    const y = it.transform?.[5] ?? null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > Math.max(2, (it.height ?? 10) * 0.5) && !out.endsWith("\n")) out += "\n";
    out += it.str;
    if (it.hasEOL) out += "\n";
    if (it.str) lastY = y;
  }
  return out;
}

/** Fetches a page through the rendering service (PRERENDER_URL with {url}), which runs its JavaScript. */
async function prerender(url: string): Promise<string> {
  const template = env("PRERENDER_URL")!;
  const res = await fetch(template.replace("{url}", encodeURIComponent(url)), { signal: AbortSignal.timeout(envNum("PRERENDER_TIMEOUT_MS", 30_000)) });
  if (!res.ok) throw new Error(`Rendering ${url} failed with HTTP ${res.status}`);
  return readLimited(res).then((b) => b.toString("utf8"));
}

export async function fetchDocs(startUrl: string, maxPages: number): Promise<Doc[]> {
  const limit = Math.max(1, Math.min(maxPages, MAX_CRAWL_PAGES));
  const docs: Doc[] = [];
  const queue = [startUrl];
  const seen = new Set<string>([startUrl]);
  let firstError: Error | null = null;
  while (queue.length && docs.length < limit) {
    const next = queue.shift()!;
    try {
      const { url, contentType, body } = await safeFetch(next);
      if (contentType.includes("application/pdf")) {
        const pdf = await pdfText(body);
        docs.push({ title: url.pathname.split("/").pop() || url.href, url: url.href, text: pdf.text, blocks: pdf.blocks });
      } else if (contentType.includes("html")) {
        const html = body.toString("utf8");
        let { doc, links } = htmlToDoc(html, url);
        if (looksClientRendered(html, doc.text.length)) {
          if (env("PRERENDER_URL")) ({ doc, links } = htmlToDoc(await prerender(url.href), url));
          else if (next === startUrl)
            throw new PermanentIngestError(
              "This website builds its pages with JavaScript, so its text couldn't be read directly. Upload a PDF or paste the text instead (or ask the platform admin to set up page rendering)."
            );
        }
        if (doc.text.length > 30) docs.push(doc);
        for (const l of links) if (!seen.has(l) && seen.size < limit * 10) (seen.add(l), queue.push(l));
      } else if (contentType.startsWith("text/")) {
        const text = normalizeText(body.toString("utf8"));
        docs.push({ title: url.href, url: url.href, text, blocks: textToBlocks(text) });
      } else {
        throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
      }
    } catch (e) {
      if (!firstError) firstError = e as Error;
      if (next === startUrl) throw e; // the page the user asked for must work
    }
  }
  if (!docs.length) throw firstError ?? new Error("No readable text found at that URL");
  return docs;
}

// ---------------------------------------------------------------------------
// Chunk -> embed -> store (one transaction, so a retried job never leaves duplicates or half a source).
// Throws on failure; the ingestion queue decides whether to retry.
// ---------------------------------------------------------------------------
export type WriteResult = { chars: number; chunks: number; embedded: number; reused: number; changed: boolean };

/**
 * Structure-aware chunking → embedding → storage, in one transaction. Passages whose embedded text is unchanged since
 * the last run reuse their stored vector (by content hash), so re-syncing a website only pays for what changed; when
 * nothing changed at all the stored passages are left alone.
 */
export async function writeChunks(sourceId: string, agentId: string, docs: Doc[]): Promise<WriteResult> {
  const maxTokens = envNum("CHUNK_TOKENS", 180);
  const contextTokens = envNum("CONTEXT_TOKENS", 600);
  const model = embeddingModelId();
  const pieces: { title: string; url: string | null; content: string; headingPath: string; page: number | null; context: string; embedText: string; hash: string }[] = [];
  let chars = 0;
  for (const d of docs) {
    chars += d.text.length;
    // CHUNKER=flat: the previous fixed-size splitter (for comparisons with pnpm eval, or as an emergency switch).
    const chunks =
      env("CHUNKER")?.toLowerCase() === "flat"
        ? chunkText(d.text, envNum("CHUNK_SIZE", 900), envNum("CHUNK_OVERLAP", 120)).map((content) => ({ content, headingPath: [] as string[], page: null, context: content }))
        : chunkBlocks(d.blocks ?? textToBlocks(d.text), { maxTokens, contextTokens });
    for (const c of chunks) {
      const headingPath = c.headingPath.join(" › ");
      // Embedded with where it lives, so "₹265" still carries "Price list › Atta".
      const embedText = [d.title, headingPath].filter(Boolean).join(" › ") + "\n" + c.content;
      const hash = createHash("sha256").update(`${model}\n${embedText}`).digest("hex").slice(0, 32);
      pieces.push({ title: d.title, url: d.url, content: c.content, headingPath, page: c.page, context: c.context, embedText, hash });
    }
  }
  if (!pieces.length) throw new PermanentIngestError("No readable text found in this source");
  if (pieces.length > 5000) throw new PermanentIngestError("Source is too large (more than 5,000 passages)");

  // Reuse vectors of passages whose embedded text (and model) haven't changed.
  const existing = new Map(
    (
      await q<{ content_hash: string; embedding: string; context: string | null; page_url: string | null; heading_path: string; page: number | null }>(
        "SELECT content_hash, embedding::text AS embedding, context, page_url, heading_path, page FROM chunks WHERE source_id = $1 AND embedding_model = $2 AND content_hash IS NOT NULL",
        [sourceId, model]
      )
    ).map((r) => [r.content_hash, r])
  );
  const unchanged =
    existing.size === pieces.length &&
    pieces.every((p) => {
      const e = existing.get(p.hash);
      // A NULL context means "the passage itself" (the hash already guarantees the passage is the same).
      return e && (e.context ?? p.content) === p.context && e.page_url === p.url && e.heading_path === p.headingPath && e.page === p.page;
    });
  if (unchanged) return { chars, chunks: pieces.length, embedded: 0, reused: pieces.length, changed: false };

  const todo = pieces.filter((p) => !existing.has(p.hash));
  const embedder = getEmbedder();
  const embedChars = todo.reduce((n, p) => n + p.embedText.length, 0);
  const t0 = Date.now();
  let fresh: number[][] = [];
  if (todo.length) {
    try {
      fresh = await embedAll(todo.map((p) => p.embedText));
    } catch (e) {
      await recordIngest({ agentId, provider: embedder.name, model: embedder.model, chars: embedChars, ms: Date.now() - t0, status: "error", error: (e as Error).message });
      throw e;
    }
    await recordIngest({ agentId, provider: embedder.name, model: embedder.model, chars: embedChars, ms: Date.now() - t0, status: "ok" });
  }
  const vectorOf = new Map<string, string>();
  todo.forEach((p, i) => vectorOf.set(p.hash, toVector(fresh[i])));
  for (const [h, e] of existing) if (!vectorOf.has(h)) vectorOf.set(h, e.embedding);

  await tx(async (query) => {
    await query("DELETE FROM chunks WHERE source_id = $1", [sourceId]);
    const BATCH = 100;
    const COLS = 11;
    for (let i = 0; i < pieces.length; i += BATCH) {
      const slice = pieces.slice(i, i + BATCH);
      const params: unknown[] = [];
      const values = slice.map((p, j) => {
        const o = j * COLS;
        params.push(sourceId, agentId, p.title, p.url, p.content, vectorOf.get(p.hash), model, p.headingPath, p.page, p.context === p.content ? null : p.context, p.hash);
        return `(${Array.from({ length: COLS }, (_, k) => `$${o + k + 1}${k === 5 ? "::vector" : ""}`).join(",")})`;
      });
      await query(
        `INSERT INTO chunks (source_id, agent_id, page_title, page_url, content, embedding, embedding_model, heading_path, page, context, content_hash) VALUES ${values.join(",")}`,
        params
      );
    }
    // Moves the agent's knowledge version (trigger), which invalidates cached answers.
    await query("UPDATE sources SET content_version = content_version + 1 WHERE id = $1", [sourceId]);
  });
  return { chars, chunks: pieces.length, embedded: todo.length, reused: pieces.length - todo.length, changed: true };
}

/** An ingestion failure that retrying can't fix (a 404 page, an empty file...). */
export class PermanentIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentIngestError";
  }
}
