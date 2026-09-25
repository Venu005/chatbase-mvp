import { NextResponse } from "next/server";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { ingestInBackground, ownAgent } from "@/lib/agents";
import { assertPublicUrl, fetchDocs } from "@/lib/ingest";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

async function ownSourceId(userId: string, params: Ctx["params"]) {
  const { id, sourceId } = await params;
  const agent = await ownAgent(userId, id);
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new HttpError(404, "Source not found");
  return { agent, sourceId };
}

/**
 * Retry a failed website source with its original URL and crawl depth. Files and pasted text aren't kept
 * after ingestion, so those have to be added again.
 */
export const POST = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { agent, sourceId } = await ownSourceId(user.id, params);
  const src = await q1<{ type: string; url: string | null; status: string; crawl_pages: number }>(
    "SELECT type, url, status, crawl_pages FROM sources WHERE id = $1 AND agent_id = $2",
    [sourceId, agent.id]
  );
  if (!src) throw new HttpError(404, "Source not found");
  if (src.type !== "url" || !src.url) throw new HttpError(400, "Only website sources can be retried. Remove this one and add it again.");
  if (src.status !== "failed") throw new HttpError(409, "Only a failed source can be retried");
  try {
    await assertPublicUrl(src.url);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  // Claim the retry atomically so a double click doesn't start two crawls.
  const claimed = await q(
    "UPDATE sources SET status = 'processing', error = NULL, updated_at = now() WHERE id = $1 AND status = 'failed' RETURNING id",
    [sourceId]
  );
  if (!claimed.length) throw new HttpError(409, "Only a failed source can be retried");
  await q("DELETE FROM chunks WHERE source_id = $1", [sourceId]);
  const url = src.url;
  ingestInBackground(sourceId, agent.id, () => fetchDocs(url, src.crawl_pages));
  return NextResponse.json({ source: { id: sourceId, status: "processing" } }, { status: 202 });
});

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { agent, sourceId } = await ownSourceId(user.id, params);
  const res = await q("DELETE FROM sources WHERE id = $1 AND agent_id = $2 RETURNING id", [sourceId, agent.id]);
  if (!res.length) throw new HttpError(404, "Source not found");
  return NextResponse.json({ ok: true });
});
