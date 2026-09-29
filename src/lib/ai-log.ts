import { q } from "./db";
import { env } from "./env";
import { costUsd, embeddingCostUsd, parsePrices } from "./pricing";
import type { Run } from "./providers/resilient";
import { estimateTokens } from "./providers/types";
import type { Prepared } from "./answer";

let prices: ReturnType<typeof parsePrices> | null = null;
const priceTable = () => (prices ??= parsePrices(env("LLM_PRICES")));

/** Records one bot answer (or failed attempt) in ai_calls. Never throws: logging must not break a reply. */
export async function recordAnswer(
  p: Prepared,
  run: Run,
  o: { status: "ok" | "partial" | "error"; messageId?: number | null; error?: unknown; answer?: string }
): Promise<void> {
  try {
    // A call that broke off mid-answer never reports usage, but the provider still bills it: estimate.
    const usage =
      run.usage ??
      (o.answer
        ? { inputTokens: estimateTokens(p.system + p.history.map((m) => m.content).join("")), outputTokens: estimateTokens(o.answer), estimated: true }
        : null);
    const error = o.error ? String((o.error as Error)?.message ?? o.error).slice(0, 500) : run.errors.length ? run.errors.join(" | ").slice(0, 500) : null;
    await q(
      `INSERT INTO ai_calls (user_id, agent_id, conversation_id, message_id, kind, channel, provider, model, prompt_version, status, error,
                             input_tokens, output_tokens, tokens_estimated, cost_usd, first_token_ms, total_ms, attempts, fallback_used,
                             question, retrieved, fixes)
       VALUES ($1,$2,$3,$4,'answer',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        p.userId,
        p.agentId,
        p.conversationId,
        o.messageId ?? null,
        p.channel,
        run.provider,
        run.model,
        p.promptVersion,
        o.status,
        error,
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
        usage?.estimated ?? !usage,
        usage ? costUsd(priceTable(), run.provider, run.model, usage.inputTokens, usage.outputTokens) : null,
        run.firstTokenMs,
        Date.now() - p.started,
        Math.max(1, run.attempts),
        run.fallbackUsed,
        p.question.slice(0, 1000),
        JSON.stringify(p.retrieved),
        JSON.stringify(p.fixes),
      ]
    );
  } catch (e) {
    console.error("Recording the AI call failed:", (e as Error).message);
  }
}

/** Records the embedding work of one ingested source (tokens estimated from its size). Never throws. */
export async function recordIngest(o: { agentId: string; provider: string; model: string; chars: number; ms: number; status: "ok" | "error"; error?: string }) {
  try {
    const tokens = Math.ceil(o.chars / 4);
    const price = env("EMBEDDING_PRICE_PER_MTOK") ? Number(env("EMBEDDING_PRICE_PER_MTOK")) : undefined;
    await q(
      `INSERT INTO ai_calls (user_id, agent_id, kind, provider, model, status, error, input_tokens, tokens_estimated, cost_usd, total_ms)
       SELECT a.user_id, a.id, 'ingest', $2, $3, $4, $5, $6, true, $7, $8 FROM agents a WHERE a.id = $1`,
      [o.agentId, o.provider, o.model, o.status, o.error?.slice(0, 500) ?? null, tokens, embeddingCostUsd(price, o.provider, tokens), o.ms]
    );
  } catch (e) {
    console.error("Recording the ingest call failed:", (e as Error).message);
  }
}
