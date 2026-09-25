import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1, toVector } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";
import { getEmbedder } from "@/lib/providers";
import { MAX_FIXES, fixBody } from "@/lib/fixes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Owner-written Q&A pairs ("Fix this answer"). */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const fixes = await q(
    "SELECT id, question, answer, message_id, created_at, updated_at FROM answer_fixes WHERE agent_id = $1 ORDER BY created_at DESC",
    [agent.id]
  );
  return NextResponse.json({ fixes });
});

const createBody = fixBody.extend({
  // The bot answer being corrected (from the inbox). Must belong to this agent.
  messageId: z.coerce.number().int().positive().optional(),
});

export const POST = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const b = createBody.parse(await req.json());
  const count = (await q1<{ n: number }>("SELECT count(*)::int AS n FROM answer_fixes WHERE agent_id = $1", [agent.id]))!.n;
  if (count >= MAX_FIXES) throw new HttpError(400, `An agent can have up to ${MAX_FIXES} Q&A answers`);
  if (b.messageId !== undefined) {
    const owned = await q1("SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 AND c.agent_id = $2", [b.messageId, agent.id]);
    if (!owned) throw new HttpError(404, "Message not found");
  }
  const [vec] = await getEmbedder().embed([b.question]);
  const fix = await q1(
    `INSERT INTO answer_fixes (agent_id, question, answer, embedding, message_id) VALUES ($1,$2,$3,$4::vector,$5)
     RETURNING id, question, answer, message_id, created_at, updated_at`,
    [agent.id, b.question, b.answer, toVector(vec), b.messageId ?? null]
  );
  return NextResponse.json({ fix }, { status: 201 });
});
