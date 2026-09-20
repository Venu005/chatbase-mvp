import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id, sourceId } = await params;
  const agent = await ownAgent(user.id, id);
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new HttpError(404, "Source not found");
  const res = await q("DELETE FROM sources WHERE id = $1 AND agent_id = $2 RETURNING id", [sourceId, agent.id]);
  if (!res.length) throw new HttpError(404, "Source not found");
  return NextResponse.json({ ok: true });
});
