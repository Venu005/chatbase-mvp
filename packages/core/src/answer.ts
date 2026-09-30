import { q, q1 } from "./db";
import { HttpError } from "./errors";
import { getFallbackLLM, getLLM, getSmallLLM } from "./providers";
import { isSmallTalk, route, type Route } from "./routing";
import { newRun, resilientStream, type Run } from "./providers/resilient";
import { trimHistory } from "./providers/turns";
import { recordAnswer } from "./ai-log";
import { queryRewriteEnabled, rewriteFollowUp } from "./query-rewrite";
import { questionKey } from "./cache-key";
import { env } from "./env";
import type { Usage } from "./providers/types";
import { envNum } from "./env";
import type { ChatMessage } from "./providers/types";
import { PROMPT_VERSION, buildSystemPrompt, retrieveKnowledge, toCitations, type Citation } from "./rag";
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
  lead_mode: "off" | "after_first_answer" | "before_chat";
  knowledge_version: string;
};
export type Channel = "widget" | "playground" | "whatsapp" | "voice" | "phone";

export const isVoice = (c: Channel) => c === "voice" || c === "phone";

/** Added to the prompt when the answer will be spoken (website voice mode, phone calls). */
const VOICE_STYLE = `
Your reply will be spoken aloud by a voice assistant, not read. Answer in one to three short, natural sentences.
Do not use lists, markdown, headings, emojis, [n] citation markers or links. Say prices and numbers the way people say
them. If the answer is long, give the key point and offer to share more.`;

const HISTORY_TURNS = 10;

export async function loadAgent(agentId: string): Promise<AnswerAgent | null> {
  return q1<AnswerAgent>(
    `SELECT a.id, a.user_id, a.name, a.instructions, a.handoff_enabled, a.handoff_message, a.lead_mode, a.knowledge_version, u.plan
       FROM agents a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
    [agentId]
  );
}

export type Prepared = {
  conversationId: string;
  agentId: string;
  userId: string;
  channel: Channel;
  question: string;
  promptVersion: string;
  /** What retrieval found, kept for the answer trace. */
  retrieved: { chunkId: number; score: number; title: string; url: string | null; via?: string }[];
  fixes: { id: string; score: number; question: string }[];
  /** What retrieval searched for, and the follow-up rewrite that produced it (if QUERY_REWRITE=on). */
  searchQuery: string;
  rewrite: { model: string; usage: Usage | null } | null;
  system: string;
  history: ChatMessage[];
  citations: Citation[];
  /** An owner Q&A fix matched: then only passages the answer explicitly cites are shown (a fix has no source). */
  fixMatched: boolean;
  /** Nothing in the sources or Q&A answers matched (shown as a knowledge gap in Analytics). */
  knowledgeGap: boolean;
  /** Answer-cache key when this answer may be cached or served from the cache (first questions only). */
  cache: { key: string; knowledgeVersion: string; model: string } | null;
  /** Set when the answer comes from the cache: no search and no model call were needed. */
  cached: { answer: string } | null;
  /** "small" = small talk or a close Q&A match, answered by LLM_SMALL_MODEL when one is configured. */
  route: Route;
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
    const history: ChatMessage[] = [...trimHistory(prior, envNum("HISTORY_MAX_CHARS", 6000)), { role: "user", content: message }];

    // Answer cache: a visitor's first question, asked word for word before, gets the stored answer if nothing that
    // shapes answers (sources, Q&A, instructions, prompt, model) has changed since. The owner's playground always
    // gets a fresh answer.
    // The model part of the key covers the main and the small model, so changing either invalidates cached answers.
    const main = getLLM();
    const small = getSmallLLM();
    const models = `${main.name}:${main.model}${small ? `|${small.name}:${small.model}` : ""}`;
    // Spoken answers are written differently (short, no lists), so they are cached separately from typed ones.
    const key =
      channel !== "playground" && answerCacheEnabled() && !prior.some((m) => m.role === "user") ? `${isVoice(channel) ? "voice:" : ""}${questionKey(message)}` : null;
    const cache = key ? { key, knowledgeVersion: agent.knowledge_version, model: models } : null;
    if (cache) {
      const hit = await q1<{ answer: string; citations: Citation[]; knowledge_gap: boolean }>(
        `UPDATE answer_cache SET hits = hits + 1
          WHERE agent_id = $1 AND question_key = $2 AND knowledge_version = $3 AND prompt_version = $4 AND model = $5
            AND created_at > now() - ($6 || ' hours')::interval
          RETURNING answer, citations, knowledge_gap`,
        [agent.id, cache.key, cache.knowledgeVersion, PROMPT_VERSION, cache.model, String(envNum("ANSWER_CACHE_TTL_HOURS", 24))]
      );
      if (hit) {
        await q("INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)", [conversationId, message]);
        return {
          conversationId,
          agentId: agent.id,
          userId: agent.user_id,
          channel,
          question: message,
          searchQuery: message,
          rewrite: null,
          promptVersion: PROMPT_VERSION,
          retrieved: [],
          fixes: [],
          system: "",
          history,
          citations: hit.citations,
          fixMatched: false,
          knowledgeGap: hit.knowledge_gap,
          cache,
          cached: { answer: hit.answer },
          route: "main",
          started,
        };
      }
    }

    // Retrieval query = the latest question plus the previous user question, so follow-ups like "and the price?" still work.
    const lastUser = [...prior].reverse().find((m) => m.role === "user")?.content;
    // Follow-ups ("and the 10 kg one?") need the earlier question to be searchable: rewritten by a small model when
    // QUERY_REWRITE=on, otherwise the previous question is simply searched together with the new message.
    const rewrite = lastUser && queryRewriteEnabled() ? await rewriteFollowUp(prior, message) : null;
    const searchQuery = rewrite?.query ?? (lastUser ? `${lastUser}\n${message}` : message);
    // Small talk ("thanks!", "hi") needs no search, and isn't a gap in the agent's knowledge.
    const smallTalk = isSmallTalk(message);
    const { chunks, fixes } = smallTalk ? { chunks: [], fixes: [] } : await retrieveKnowledge(agent.id, searchQuery, message);

    await q("INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)", [conversationId, message]);
    return {
      conversationId,
      agentId: agent.id,
      userId: agent.user_id,
      channel,
      question: message,
      searchQuery,
      rewrite: rewrite && { model: rewrite.model, usage: rewrite.usage },
      promptVersion: PROMPT_VERSION,
      retrieved: chunks.map((c) => ({ chunkId: Number(c.id), score: Math.round(c.score * 1000) / 1000, title: c.page_title || c.source_title, url: c.page_url, via: c.via })),
      fixes: fixes.map((f) => ({ id: f.id, score: Math.round(f.score * 1000) / 1000, question: f.question })),
      system: buildSystemPrompt(agent, chunks, { canHandoff: agent.handoff_enabled && channel !== "playground", fixes }) + (isVoice(channel) ? VOICE_STYLE : ""),
      history,
      citations: toCitations(chunks),
      fixMatched: fixes.length > 0,
      knowledgeGap: !smallTalk && !chunks.length && !fixes.length,
      cache,
      cached: null,
      route: route(message, fixes.length ? Math.max(...fixes.map((f) => f.score)) : null, envNum("ROUTE_FIX_SCORE", 0.8)),
      started,
    };
  } catch (e) {
    await refundCredit(agent.user_id).catch(() => {});
    throw e;
  }
}

/** Stores the bot's reply; returns its message id (the widget uses it for 👍/👎 feedback). */
export const answerCacheEnabled = () => env("ANSWER_CACHE")?.toLowerCase() !== "off";

/** Streams the bot's reply through the production wrapper (timeouts, retries, backup model), or from the cache. */
export function streamAnswer(p: Prepared, run: Run, signal?: AbortSignal): AsyncGenerator<string> {
  if (p.cached) return streamCached(p, run);
  const primary = (p.route === "small" && getSmallLLM()) || getLLM();
  return resilientStream({ system: p.system, messages: p.history, signal }, primary, getFallbackLLM(), run);
}

async function* streamCached(p: Prepared, run: Run): AsyncGenerator<string> {
  Object.assign(run, { provider: "cache", model: p.cache!.model, attempts: 1, usage: { inputTokens: 0, outputTokens: 0 } });
  run.firstTokenMs = Date.now() - p.started;
  // Sent in word groups so the widget renders it the same way as a live answer.
  for (const part of p.cached!.answer.match(/\S+\s*/g) ?? [p.cached!.answer]) yield part;
}

/** Stores a fresh first answer for reuse (only answers from the main model, not the backup). Never throws. */
export async function cacheAnswer(p: Prepared, run: Run, answer: string): Promise<void> {
  if (!p.cache || p.cached || run.fallbackUsed || !answer.trim()) return;
  await q(
    `INSERT INTO answer_cache (agent_id, question_key, knowledge_version, prompt_version, model, answer, citations, knowledge_gap)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (agent_id, question_key) DO UPDATE SET knowledge_version = EXCLUDED.knowledge_version, prompt_version = EXCLUDED.prompt_version,
       model = EXCLUDED.model, answer = EXCLUDED.answer, citations = EXCLUDED.citations, knowledge_gap = EXCLUDED.knowledge_gap,
       hits = 0, created_at = now()`,
    [p.agentId, p.cache.key, p.cache.knowledgeVersion, p.promptVersion, p.cache.model, answer, JSON.stringify(p.citations), p.knowledgeGap]
  ).catch((e) => console.error("Caching the answer failed:", (e as Error).message));
}

export async function saveAnswer(p: Prepared, answer: string): Promise<number> {
  const row = await q1<{ id: string }>(
    "INSERT INTO messages (conversation_id, role, content, citations, latency_ms, knowledge_gap) VALUES ($1,'assistant',$2,$3,$4,$5) RETURNING id",
    [p.conversationId, answer, JSON.stringify(p.citations), Date.now() - p.started, p.knowledgeGap]
  );
  return Number(row!.id);
}

/**
 * Citations the model actually used. If it didn't cite inline, falls back to everything retrieved, except when an
 * owner Q&A fix matched (the answer then most likely came from the fix, which has nothing to cite).
 */
export function usedCitations(answer: string, p: Pick<Prepared, "citations" | "fixMatched">): Citation[] {
  const used = p.citations.filter((c) => answer.includes(`[${c.n}]`));
  return used.length || p.fixMatched ? used : p.citations;
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
  const run = newRun();
  try {
    for await (const delta of streamAnswer(p, run)) text += delta;
    if (!text.trim()) throw new Error("The model returned an empty reply");
  } catch (e) {
    // WhatsApp sends the reply in one piece, so a half-written answer is never sent: it's an error, credit refunded.
    await refundCredit(agent.user_id).catch(() => {});
    await recordAnswer(p, run, { status: "error", error: e, answer: text });
    throw e;
  }
  const messageId = await saveAnswer(p, text).catch((e) => (console.error("Saving reply failed:", e), null));
  await recordAnswer(p, run, { status: "ok", messageId });
  await cacheAnswer(p, run, text);
  return { text, citations: usedCitations(text, p) };
}
