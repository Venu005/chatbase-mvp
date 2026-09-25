import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@/lib/db";
import { HttpError, clientIp, handle, rateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

const schema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  messageId: z.coerce.number().int().positive(), // bigint ids arrive as strings from pg
  rating: z.enum(["up", "down"]).nullable(), // null clears the rating
});

/** 👍 / 👎 on a bot answer in the website widget. Only the visitor's own conversation (their session id) can be rated. */
export const POST = handle<Ctx>(async (req, { params }) => {
  const agentId = (await params).agentId;
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new HttpError(404, "Agent not found");
  const { sessionId, messageId, rating } = schema.parse(await req.json());
  if (!rateLimit(`feedback:${clientIp(req)}:${agentId}`, 30, 60_000)) throw new HttpError(429, "Too many requests");

  const value = rating === "up" ? 1 : rating === "down" ? -1 : null;
  const row = await q1<{ id: string }>(
    `UPDATE messages m SET feedback = $4, feedback_at = CASE WHEN $4::smallint IS NULL THEN NULL ELSE now() END
       FROM conversations c
      WHERE m.id = $3 AND m.role = 'assistant' AND m.latency_ms IS NOT NULL /* a bot answer, not a handoff notice */ AND m.conversation_id = c.id AND c.agent_id = $1 AND c.session_id = $2
      RETURNING m.id`,
    [agentId, sessionId, messageId, value]
  );
  if (!row) throw new HttpError(404, "Message not found");
  return NextResponse.json({ ok: true, rating });
});
