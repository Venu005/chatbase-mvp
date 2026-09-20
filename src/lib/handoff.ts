import { q, q1 } from "./db";
import { notifyOwner } from "./notify";
import { envNum } from "./env";

/** Human handoff: who is talking to the visitor, the bot or a person? */

export type HandoffAgent = { id: string; handoff_message: string };
export type ConvoState = { id: string; mode: "bot" | "human"; channel: string };

const AUTO_RESUME_HOURS = () => envNum("HANDOFF_AUTO_RESUME_HOURS", 24);

/**
 * Finds a conversation. If a customer has waited for a person longer than HANDOFF_AUTO_RESUME_HOURS
 * with no reply, the bot takes over again (so nobody is ignored forever). Set it to 0 to disable.
 */
export async function findConversation(agentId: string, sessionId: string): Promise<ConvoState | null> {
  const c = await q1<ConvoState & { needs_reply: boolean; stale: boolean }>(
    `SELECT id, mode, channel, needs_reply,
            (mode = 'human' AND needs_reply AND needs_reply_at < now() - ($3 || ' hours')::interval) AS stale
       FROM conversations WHERE agent_id = $1 AND session_id = $2`,
    [agentId, sessionId, String(AUTO_RESUME_HOURS())]
  );
  if (!c) return null;
  if (c.stale && AUTO_RESUME_HOURS() > 0) {
    await q("UPDATE conversations SET mode = 'bot', needs_reply = false, needs_reply_at = NULL WHERE id = $1", [c.id]);
    return { id: c.id, mode: "bot", channel: c.channel };
  }
  return { id: c.id, mode: c.mode, channel: c.channel };
}

/** A visitor wrote while a person owns the conversation: store it, flag it, and (throttled) tell the owner. */
export async function recordVisitorMessage(conversationId: string, message: string): Promise<void> {
  await q("INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)", [conversationId, message]);
  await q(
    `UPDATE conversations SET needs_reply_at = CASE WHEN needs_reply THEN needs_reply_at ELSE now() END,
                              needs_reply = true, updated_at = now() WHERE id = $1`,
    [conversationId]
  );
  void notifyOwner(conversationId, { preview: message, kind: "message" });
}

/**
 * Puts a conversation into human mode (creating it if needed), records the visitor's message and the
 * notice the visitor sees, and e-mails the owner right away.
 */
export async function startHandoff(
  agent: HandoffAgent,
  o: { sessionId: string; channel: string; reason: string; message?: string }
): Promise<{ conversationId: string; notice: string }> {
  const row = await q1<{ id: string }>(
    `INSERT INTO conversations (agent_id, session_id, channel, mode, needs_reply, needs_reply_at, handoff_reason, handoff_at)
     VALUES ($1,$2,$3,'human',true,now(),$4,now())
     ON CONFLICT (agent_id, session_id) DO UPDATE SET mode = 'human', needs_reply = true, needs_reply_at = now(),
       handoff_reason = EXCLUDED.handoff_reason, handoff_at = now(), updated_at = now()
     RETURNING id`,
    [agent.id, o.sessionId, o.channel, o.reason]
  );
  const id = row!.id;
  if (o.message) await q("INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)", [id, o.message]);
  await q("INSERT INTO messages (conversation_id, role, content) VALUES ($1,'assistant',$2)", [id, agent.handoff_message]);
  void notifyOwner(id, { force: true, preview: o.message, kind: "handoff" });
  return { conversationId: id, notice: agent.handoff_message };
}
