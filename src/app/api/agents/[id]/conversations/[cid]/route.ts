import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cid: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id, cid } = await params;
  const agent = await ownAgent(user.id, id);
  if (!/^[0-9a-f-]{36}$/i.test(cid)) throw new HttpError(404, "Conversation not found");
  const conversation = await q1(
    `SELECT id, channel, mode, needs_reply, handoff_reason,
            CASE WHEN channel = 'whatsapp' THEN '+' || substr(session_id, 4) ELSE visitor_contact END AS contact
       FROM conversations WHERE id = $1 AND agent_id = $2`,
    [cid, agent.id]
  );
  if (!conversation) throw new HttpError(404, "Conversation not found");
  const messages = await q("SELECT id, role, content, citations, feedback, created_at FROM messages WHERE conversation_id = $1 ORDER BY id", [cid]);
  return NextResponse.json({ conversation, messages });
});

const patch = z.object({ mode: z.enum(["bot", "human"]) });

/** "Hand back to the assistant" (bot) or "Take over" (human). */
export const PATCH = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const { id, cid } = await params;
  const agent = await ownAgent(user.id, id);
  if (!/^[0-9a-f-]{36}$/i.test(cid)) throw new HttpError(404, "Conversation not found");
  const { mode } = patch.parse(await req.json());
  const row = await q1(
    `UPDATE conversations SET mode = $3, needs_reply = CASE WHEN $3 = 'bot' THEN false ELSE needs_reply END,
            needs_reply_at = CASE WHEN $3 = 'bot' THEN NULL ELSE needs_reply_at END
      WHERE id = $1 AND agent_id = $2 RETURNING id, mode, needs_reply`,
    [cid, agent.id, mode]
  );
  if (!row) throw new HttpError(404, "Conversation not found");
  return NextResponse.json({ conversation: row });
});
