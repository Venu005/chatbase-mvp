import { q, q1 } from "./db";
import { HttpError } from "./http";
import { getLLM } from "./providers";
import type { ChatMessage } from "./providers/types";
import { buildSystemPrompt, retrieve, toCitations, type Citation } from "./rag";
import { refundCredit, reserveCredit } from "./usage";
import { wantsHuman } from "./handoff-intent";
import { findConversation, recordVisitorMessage, startHandoff } from "./handoff";

/**
 * The one place that turns "a visitor said X" into "the agent's answer", shared by
 * every channel (website widget, dashboard playground, WhatsApp...).
 */

export type AnswerAgent = {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  plan: string;
  handoff_enabled: boolean;
  handoff_message: string;
};
export type Channel = "widget" | "playground" | "whatsapp";

const HISTORY_TURNS = 10;

export async function loadAgent(agentId: string): Promise<AnswerAgent | null> {
  return q1<AnswerAgent>(
    `SELECT a.id, a.user_id, a.name, a.instructions, a.handoff_enabled, a.handoff_message, u.plan
       FROM agents a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
    [agentId]
  );
}

export type Prepared = {
  conversationId: string;
  system: string;
  history: ChatMessage[];
  citations: Citation[];
  started: number;
};

/** Returned instead of `Prepared` when a person, not the bot, is handling this conversation. Costs no credit. */
export type HandedOff = { handedOff: true; conversationId: string; notice: string | null };

/**
 * Decides who answers, then (for the bot) reserves one message credit (atomic), finds/creates the
 * conversation, reads history from the database (never from the client), retrieves knowledge, builds the
 * prompt and stores the user's message. If anything fails the credit is refunded and the error is rethrown.
 * Throws HttpError(402) when the account is out of credits.
 *
 * Human handoff: if the conversation is already with a person, or the visitor asks for one, the message is
 * stored, the owner is alerted, and `HandedOff` is returned (no credit is used, the bot stays silent).
 * The dashboard playground never hands off (the owner is testing).
 */
export async function prepareAnswer(agent: AnswerAgent, sessionId: string, channel: Channel, message: string): Promise<Prepared | HandedOff> {
  if (channel !== "playground") {
    const existing = await findConversation(agent.id, sessionId);
    if (existing?.mode === "human") {
      await recordVisitorMessage(existing.id, message);
      return { handedOff: true, conversationId: existing.id, notice: null };
    }
    if (agent.handoff_enabled && wantsHuman(message)) {
      const r = await startHandoff(agent, { sessionId, channel, reason: "Visitor asked for a person", message });
      return { handedOff: true, conversationId: r.conversationId, notice: r.notice };
    }
  }
  if (!(await reserveCredit(agent.user_id, agent.plan))) {
    throw new HttpError(402, "This assistant has reached its monthly message limit. Please contact the business directly.");
  }
  const started = Date.now();
  try {
    const conversationId = (await q1<{ id: string }>(
      `INSERT INTO conversations (agent_id, session_id, channel) VALUES ($1,$2,$3)
       ON CONFLICT (agent_id, session_id) DO UPDATE SET updated_at = now() RETURNING id`,
      [agent.id, sessionId, channel]
    ))!.id;

    // Messages typed by the owner count as the assistant's side of the conversation.
    const prior = await q<ChatMessage>(
      `SELECT CASE WHEN role = 'user' THEN 'user' ELSE 'assistant' END AS role, content FROM (
         SELECT id, role, content FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
       ) t ORDER BY id`,
      [conversationId, HISTORY_TURNS * 2]
    );
    const history: ChatMessage[] = [...prior, { role: "user", content: message }];

    // Retrieval query = the latest question plus the previous user question, so follow-ups like "and the price?" still work.
    const lastUser = [...prior].reverse().find((m) => m.role === "user")?.content;
    const chunks = await retrieve(agent.id, lastUser ? `${lastUser}\n${message}` : message);

    await q("INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)", [conversationId, message]);
    return {
      conversationId,
      system: buildSystemPrompt(agent, chunks, { canHandoff: agent.handoff_enabled && channel !== "playground" }),
      history,
      citations: toCitations(chunks),
      started,
    };
  } catch (e) {
    await refundCredit(agent.user_id).catch(() => {});
    throw e;
  }
}

/** Stores the bot's reply; returns its message id (the widget uses it for 👍/👎 feedback). */
export async function saveAnswer(p: Prepared, answer: string): Promise<number> {
  const row = await q1<{ id: string }>(
    "INSERT INTO messages (conversation_id, role, content, citations, latency_ms) VALUES ($1,'assistant',$2,$3,$4) RETURNING id",
    [p.conversationId, answer, JSON.stringify(p.citations), Date.now() - p.started]
  );
  return Number(row!.id);
}

/** Citations the model actually used; falls back to everything retrieved if it didn't cite inline. */
export function usedCitations(answer: string, citations: Citation[]): Citation[] {
  const used = citations.filter((c) => answer.includes(`[${c.n}]`));
  return used.length ? used : citations;
}

/** Non-streaming answer for channels that send one whole message (WhatsApp). Handles credit refund on failure. */
export async function answerOnce(
  agent: AnswerAgent,
  sessionId: string,
  channel: Channel,
  message: string
): Promise<{ text: string; citations: Citation[] } | HandedOff> {
  const p = await prepareAnswer(agent, sessionId, channel, message);
  if ("handedOff" in p) return p;
  let text = "";
  try {
    for await (const delta of getLLM().stream({ system: p.system, messages: p.history })) text += delta;
    if (!text.trim()) throw new Error("The model returned an empty reply");
  } catch (e) {
    await refundCredit(agent.user_id).catch(() => {});
    throw e;
  }
  await saveAnswer(p, text).catch((e) => console.error("Saving reply failed:", e));
  return { text, citations: usedCitations(text, p.citations) };
}
