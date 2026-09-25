import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const conversations = await q(
    `SELECT c.id, c.channel, c.created_at, c.updated_at, c.mode, c.needs_reply, c.handoff_reason,
            CASE WHEN c.channel = 'whatsapp' THEN '+' || substr(c.session_id, 4) ELSE c.visitor_contact END AS contact,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.feedback = -1) AS thumbs_down,
            (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS last_visitor_message,
            (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_message
       FROM conversations c WHERE c.agent_id = $1
      ORDER BY c.needs_reply DESC, c.updated_at DESC LIMIT 100`,
    [agent.id]
  );
  return NextResponse.json({ conversations });
});
