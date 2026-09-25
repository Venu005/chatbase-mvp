import { NextResponse } from "next/server";
import { q, q1, toVector } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";
import { getEmbedder } from "@/lib/providers";
import { fixBody } from "@/lib/fixes";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; fixId: string }> };

async function ownFix(userId: string, params: Ctx["params"]) {
  const { id, fixId } = await params;
  const agent = await ownAgent(userId, id);
  if (!/^[0-9a-f-]{36}$/i.test(fixId)) throw new HttpError(404, "Answer not found");
  const fix = await q1<{ id: string; question: string }>("SELECT id, question FROM answer_fixes WHERE id = $1 AND agent_id = $2", [fixId, agent.id]);
  if (!fix) throw new HttpError(404, "Answer not found");
  return fix;
}

export const PATCH = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const fix = await ownFix(user.id, params);
  const b = fixBody.parse(await req.json());
  // Re-embed only when the question changed (that's what visitor questions are matched against).
  const vec = b.question === fix.question ? null : (await getEmbedder().embed([b.question]))[0];
  const row = await q1(
    `UPDATE answer_fixes SET question = $2, answer = $3, embedding = COALESCE($4::vector, embedding), updated_at = now()
      WHERE id = $1 RETURNING id, question, answer, message_id, created_at, updated_at`,
    [fix.id, b.question, b.answer, vec ? toVector(vec) : null]
  );
  return NextResponse.json({ fix: row });
});

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const fix = await ownFix(user.id, params);
  await q("DELETE FROM answer_fixes WHERE id = $1", [fix.id]);
  return NextResponse.json({ ok: true });
});
