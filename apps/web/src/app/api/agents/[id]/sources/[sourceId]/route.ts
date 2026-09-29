import { NextResponse } from "next/server";
import { q, q1 } from "@chatbase/core/db";
import { requireUser } from "@chatbase/core/auth";
import { HttpError, handle } from "@chatbase/core/http";
import { ownAgent } from "@chatbase/core/agents";
import { assertPublicUrl } from "@chatbase/core/ingest";
import { canReprocess, requeueSource } from "@chatbase/core/ingest-queue";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

async function ownSourceId(userId: string, params: Ctx["params"]) {
  const { id, sourceId } = await params;
  const agent = await ownAgent(userId, id);
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new HttpError(404, "Source not found");
  return { agent, sourceId };
}

/**
 * Retry a failed source. Websites are read again with their original page count; files and pasted text are
 * processed again from the content kept when they were added (sources added before that was kept must be re-added).
 */
export const POST = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { agent, sourceId } = await ownSourceId(user.id, params);
  const src = await q1<{ id: string; type: string; url: string | null; status: string }>("SELECT id, type, url, status FROM sources WHERE id = $1 AND agent_id = $2", [
    sourceId,
    agent.id,
  ]);
  if (!src) throw new HttpError(404, "Source not found");
  if (src.status !== "failed") throw new HttpError(409, "Only a failed source can be retried");
  if (!(await canReprocess(src))) throw new HttpError(400, "This source's original content wasn't kept. Remove it and add it again.");
  if (src.type === "url") {
    try {
      await assertPublicUrl(src.url!);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  if (!(await requeueSource(src.id))) throw new HttpError(409, "Only a failed source can be retried");
  return NextResponse.json({ source: { id: src.id, status: "processing" } }, { status: 202 });
});

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { agent, sourceId } = await ownSourceId(user.id, params);
  const res = await q("DELETE FROM sources WHERE id = $1 AND agent_id = $2 RETURNING id", [sourceId, agent.id]);
  if (!res.length) throw new HttpError(404, "Source not found");
  return NextResponse.json({ ok: true });
});
