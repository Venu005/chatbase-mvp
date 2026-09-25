import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; leadId: string }> };

/** Deletes a lead (for example when a customer asks to be forgotten). The conversation itself stays. */
export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id, leadId } = await params;
  const agent = await ownAgent(user.id, id);
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) throw new HttpError(404, "Lead not found");
  const res = await q("DELETE FROM leads WHERE id = $1 AND agent_id = $2 RETURNING id", [leadId, agent.id]);
  if (!res.length) throw new HttpError(404, "Lead not found");
  return NextResponse.json({ ok: true });
});
