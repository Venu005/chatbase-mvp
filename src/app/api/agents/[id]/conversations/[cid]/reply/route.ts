import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { HttpError, handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";
import { phoneFromSession } from "@/lib/handoff-intent";
import { sendText } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cid: string }> };

const schema = z.object({ message: z.string().trim().min(1, "Type a reply").max(4000) });

/**
 * The business owner answers a customer. This also takes the conversation over (mode = human), so the
 * assistant does not talk over the owner. On WhatsApp the reply is sent through the Cloud API first; if
 * WhatsApp refuses it (for example the 24-hour customer-service window has closed) nothing is saved.
 */
export const POST = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const { id, cid } = await params;
  const agent = await ownAgent(user.id, id);
  if (!/^[0-9a-f-]{36}$/i.test(cid)) throw new HttpError(404, "Conversation not found");
  const { message } = schema.parse(await req.json());

  const convo = await q1<{ id: string; channel: string; session_id: string }>("SELECT id, channel, session_id FROM conversations WHERE id = $1 AND agent_id = $2", [cid, agent.id]);
  if (!convo) throw new HttpError(404, "Conversation not found");

  if (convo.channel === "whatsapp") {
    const to = phoneFromSession(convo.session_id)?.slice(1);
    const ch = await q1<{ phone_number_id: string; access_token_enc: string }>("SELECT phone_number_id, access_token_enc FROM whatsapp_channels WHERE agent_id = $1", [agent.id]);
    if (!to || !ch) throw new HttpError(409, "WhatsApp is no longer connected for this agent, so this reply can't be delivered.");
    try {
      const token = decryptSecret(ch.access_token_enc);
      for (let i = 0; i < message.length; i += 4000) await sendText(ch.phone_number_id, token, to, message.slice(i, i + 4000));
    } catch (e) {
      throw new HttpError(
        502,
        `${(e as Error).message}. WhatsApp only allows free-form replies within 24 hours of the customer's last message.`
      );
    }
  }

  const row = await q1<{ id: number; created_at: string }>("INSERT INTO messages (conversation_id, role, content) VALUES ($1,'human',$2) RETURNING id, created_at", [convo.id, message]);
  await q("UPDATE conversations SET mode = 'human', needs_reply = false, needs_reply_at = NULL, updated_at = now() WHERE id = $1", [convo.id]);
  return NextResponse.json({ message: { id: row!.id, role: "human", content: message, created_at: row!.created_at } });
});
