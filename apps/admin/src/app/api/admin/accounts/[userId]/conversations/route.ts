import { NextResponse } from "next/server";
import { q, q1 } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { HttpError, handle } from "@chatbase/core/http";
import { audit } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ userId: string }> };

/**
 * Read-only view of an account's conversations, for support ("see what the customer sees"). Every look is written to
 * the audit log, because these are the customer's visitors' messages.
 *   ?cid=<conversation id>   one conversation's messages
 */
export const GET = handle<Ctx>(async (req, { params }) => {
  const me = await requireAdmin();
  const userId = (await params).userId;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(404, "Account not found");
  const user = await q1<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
  if (!user) throw new HttpError(404, "Account not found");
  const cid = req.nextUrl.searchParams.get("cid");

  if (cid) {
    if (!/^[0-9a-f-]{36}$/i.test(cid)) throw new HttpError(404, "Conversation not found");
    const convo = await q1(
      `SELECT c.id, c.channel, c.created_at, c.mode, c.handoff_reason, a.name AS agent_name
         FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1 AND a.user_id = $2`,
      [cid, userId]
    );
    if (!convo) throw new HttpError(404, "Conversation not found");
    const messages = await q(
      "SELECT id, role, content, citations, feedback, knowledge_gap, created_at FROM messages WHERE conversation_id = $1 ORDER BY id LIMIT 500",
      [cid]
    );
    await audit(me, "account.view_conversation", { id: userId, email: user.email }, { conversation_id: cid });
    return NextResponse.json({ conversation: convo, messages });
  }

  const conversations = await q(
    `SELECT c.id, c.channel, c.created_at, c.updated_at, c.mode, a.name AS agent_name,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS messages,
            (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY id LIMIT 1) AS first_question,
            EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.knowledge_gap) AS has_gap,
            EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.feedback = -1) AS has_down
       FROM conversations c JOIN agents a ON a.id = c.agent_id
      WHERE a.user_id = $1 ORDER BY c.updated_at DESC LIMIT 50`,
    [userId]
  );
  await audit(me, "account.view_conversations", { id: userId, email: user.email });
  return NextResponse.json({ conversations });
});
