import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { HttpError, clientIp, handle, rateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

const query = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  after: z.coerce.number().int().min(0).optional().default(0),
  all: z.enum(["0", "1"]).optional().default("0"),
});

/**
 * Used by the chat widget (the session id is the visitor's secret):
 *  - ?all=1            restores the visitor's conversation after a page reload
 *  - ?after=<msg id>   polls for messages typed by the business owner while a person handles the chat
 * Returns { mode: "bot" | "human", messages: [...] }.
 */
export const GET = handle<Ctx>(async (req, { params }) => {
  const agentId = (await params).agentId;
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new HttpError(404, "Agent not found");
  const p = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  if (!rateLimit(`poll:${clientIp(req)}:${agentId}`, 60, 60_000)) throw new HttpError(429, "Too many requests");

  const convo = await q1<{ id: string; mode: "bot" | "human"; has_contact: boolean }>(
    "SELECT id, mode, visitor_contact IS NOT NULL AS has_contact FROM conversations WHERE agent_id = $1 AND session_id = $2",
    [agentId, p.sessionId]
  );
  if (!convo) return NextResponse.json({ mode: "bot", hasContact: false, messages: [] });

  const messages =
    p.all === "1"
      ? await q(
          `SELECT id, role, content, citations, created_at FROM (
             SELECT id, role, content, citations, created_at FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 100
           ) t ORDER BY id`,
          [convo.id]
        )
      : await q("SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 AND role = 'human' AND id > $2 ORDER BY id LIMIT 50", [convo.id, p.after]);
  return NextResponse.json({ mode: convo.mode, hasContact: convo.has_contact, messages });
});
