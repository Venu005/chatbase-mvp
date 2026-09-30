import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@chatbase/core/db";
import { requireUser } from "@chatbase/core/auth";
import { HttpError, handle } from "@chatbase/core/http";
import { ownAgent } from "@chatbase/core/agents";
import { enqueueSource } from "@chatbase/core/ingest-queue";
import { OCR_IMAGE_TYPES, ocrConfigured } from "@chatbase/core/ocr";
import { MAX_CRAWL_PAGES, assertPublicUrl } from "@chatbase/core/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MAX_SOURCES = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 500_000;

export const GET = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const acceptsImages = ocrConfigured();
  const sources = await q(
    `SELECT s.id, s.type, s.title, s.url, s.status, s.error, s.char_count, s.chunk_count, s.created_at, s.last_synced_at,
            (s.type = 'url' OR EXISTS (SELECT 1 FROM source_payloads p WHERE p.source_id = s.id AND (p.docs IS NOT NULL OR p.file IS NOT NULL))) AS retryable
       FROM sources s WHERE s.agent_id = $1 ORDER BY s.created_at DESC`,
    [agent.id]
  );
  return NextResponse.json({ sources, acceptsImages });
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
    const images = ocrConfigured() ? Object.keys(OCR_IMAGE_TYPES) : [];
    if (!ext || ![...["pdf", "txt", "md", "csv"], ...images].includes(ext)) {
      throw new HttpError(400, `Supported files: PDF, TXT, MD, CSV${images.length ? ", JPG, PNG, WEBP" : ""}`);
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const src = await newSource(agent.id, "file", name, null);
    await enqueueSource(src.id, { file: buf, fileExt: ext });
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
    await enqueueSource(src.id, null);
    return NextResponse.json({ source: { id: src.id, status: "processing" } }, { status: 202 });
  }

  // --- Pasted text / FAQ ---------------------------------------------------------
  const b = textBody.parse(body);
  const src = await newSource(agent.id, "text", b.title, null);
  await enqueueSource(src.id, { docs: [{ title: b.title, url: null, text: b.text }] });
  return NextResponse.json({ source: { id: src.id, status: "processing" } }, { status: 202 });
});
