import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { failStaleSources, ingestInBackground, ownAgent } from "@/lib/agents";
import { MAX_CRAWL_PAGES, assertPublicUrl, fetchDocs, pdfToText } from "@/lib/ingest";
import { normalizeText } from "@/lib/chunk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MAX_SOURCES = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 500_000;

export const GET = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  await failStaleSources(agent.id);
  const sources = await q(
    `SELECT id, type, title, url, status, error, char_count, chunk_count, created_at
       FROM sources WHERE agent_id = $1 ORDER BY created_at DESC`,
    [agent.id]
  );
  return NextResponse.json({ sources });
});

const urlBody = z.object({
  type: z.literal("url"),
  url: z.string().trim().url().max(2000),
  crawlPages: z.number().int().min(1).max(MAX_CRAWL_PAGES).optional().default(1),
});
const textBody = z.object({
  type: z.literal("text"),
  title: z.string().trim().min(1).max(120),
  text: z.string().min(20, "Add a little more text").max(MAX_TEXT_CHARS),
});

async function newSource(agentId: string, type: "url" | "file" | "text", title: string, url: string | null, crawlPages = 1) {
  const count = (await q1<{ n: number }>("SELECT count(*)::int AS n FROM sources WHERE agent_id = $1", [agentId]))!.n;
  if (count >= MAX_SOURCES) throw new HttpError(400, `An agent can have up to ${MAX_SOURCES} sources`);
  return (await q1<{ id: string }>(
    "INSERT INTO sources (agent_id, type, title, url, crawl_pages) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [agentId, type, title, url, crawlPages]
  ))!;
}

export const POST = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const contentType = req.headers.get("content-type") ?? "";

  // --- File upload (multipart/form-data) -----------------------------------
  if (contentType.includes("multipart/form-data")) {
    const file = (await req.formData()).get("file");
    if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
    if (file.size > MAX_FILE_BYTES) throw new HttpError(400, "File is too large (limit 10 MB)");
    const name = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "upload";
    const ext = name.split(".").pop()?.toLowerCase();
    if (!ext || !["pdf", "txt", "md", "csv"].includes(ext)) throw new HttpError(400, "Supported files: PDF, TXT, MD, CSV");
    const buf = new Uint8Array(await file.arrayBuffer());
    const src = await newSource(agent.id, "file", name, null);
    ingestInBackground(src.id, agent.id, async () => {
      const text = ext === "pdf" ? await pdfToText(buf) : normalizeText(new TextDecoder("utf-8").decode(buf));
      return [{ title: name, url: null, text }];
    });
    return NextResponse.json({ source: { id: src.id, status: "processing" } }, { status: 202 });
  }

  const body = await req.json();

  // --- Website URL (optionally crawl same-site links) ------------------------
  if (body?.type === "url") {
    const b = urlBody.parse(body);
    let url: URL;
    try {
      url = await assertPublicUrl(b.url);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const src = await newSource(agent.id, "url", url.hostname + (url.pathname === "/" ? "" : url.pathname), url.href, b.crawlPages);
    ingestInBackground(src.id, agent.id, () => fetchDocs(url.href, b.crawlPages));
    return NextResponse.json({ source: { id: src.id, status: "processing" } }, { status: 202 });
  }

  // --- Pasted text / FAQ ---------------------------------------------------------
  const b = textBody.parse(body);
  const src = await newSource(agent.id, "text", b.title, null);
  ingestInBackground(src.id, agent.id, async () => [{ title: b.title, url: null, text: b.text }]);
  return NextResponse.json({ source: { id: src.id, status: "processing" } }, { status: 202 });
});
