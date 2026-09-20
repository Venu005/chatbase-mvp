import dns from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";
import { extractText, getDocumentProxy } from "unpdf";
import { q, toVector } from "./db";
import { chunkText, normalizeText } from "./chunk";
import { embedAll } from "./providers";

export type Doc = { title: string; url: string | null; text: string };

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
  const title = normalizeText($("title").first().text()) || pageUrl.href;
  $("script,style,noscript,svg,iframe,nav,footer,header,form,aside,template").remove();
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,h4,h5,h6,tr,section,article,blockquote,pre").each((_, el) => {
    $(el).append("\n");
  });
  const root = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
  return { doc: { title, url: pageUrl.href, text: normalizeText(root.text()) }, links: [...links] };
}

export async function pdfToText(buf: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return normalizeText(Array.isArray(text) ? text.join("\n\n") : text);
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
        docs.push({ title: url.pathname.split("/").pop() || url.href, url: url.href, text: await pdfToText(body) });
      } else if (contentType.includes("html")) {
        const { doc, links } = htmlToDoc(body.toString("utf8"), url);
        if (doc.text.length > 30) docs.push(doc);
        for (const l of links) if (!seen.has(l) && seen.size < limit * 10) (seen.add(l), queue.push(l));
      } else if (contentType.startsWith("text/")) {
        docs.push({ title: url.href, url: url.href, text: normalizeText(body.toString("utf8")) });
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
// Chunk -> embed -> store. Updates the source row to ready / failed.
// ---------------------------------------------------------------------------
export async function indexDocs(sourceId: string, agentId: string, docs: Doc[]): Promise<void> {
  try {
    const pieces: { title: string; url: string | null; content: string }[] = [];
    let chars = 0;
    for (const d of docs) {
      chars += d.text.length;
      for (const content of chunkText(d.text)) pieces.push({ title: d.title, url: d.url, content });
    }
    if (!pieces.length) throw new Error("No readable text found in this source");
    if (pieces.length > 5000) throw new Error("Source is too large (more than 5,000 chunks)");

    const vectors = await embedAll(pieces.map((p) => p.content));

    const BATCH = 100;
    for (let i = 0; i < pieces.length; i += BATCH) {
      const slice = pieces.slice(i, i + BATCH);
      const params: unknown[] = [];
      const values = slice.map((p, j) => {
        const o = j * 6;
        params.push(sourceId, agentId, p.title, p.url, p.content, toVector(vectors[i + j]));
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6}::vector)`;
      });
      await q(`INSERT INTO chunks (source_id, agent_id, page_title, page_url, content, embedding) VALUES ${values.join(",")}`, params);
    }
    await q("UPDATE sources SET status='ready', error=NULL, char_count=$2, chunk_count=$3 WHERE id=$1", [sourceId, chars, pieces.length]);
  } catch (e) {
    await q("DELETE FROM chunks WHERE source_id=$1", [sourceId]).catch(() => {});
    await q("UPDATE sources SET status='failed', error=$2 WHERE id=$1", [sourceId, String((e as Error).message).slice(0, 500)]).catch(() => {});
  }
}
