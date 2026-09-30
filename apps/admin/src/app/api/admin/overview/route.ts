import { NextResponse } from "next/server";
import { q, q1 } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@chatbase/core/http";
import { SINCE, TZ, periodQuery, usdInrRate } from "@/lib/admin";
import { planOf } from "@chatbase/core/plans";
import { embeddingModelId, getFallbackLLM, getLLM } from "@chatbase/core/providers";
import { env } from "@chatbase/core/env";
import { currentAlerts } from "@chatbase/core/ops-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the admin overview shows, for the last N days. */
export const GET = handle(async (req) => {
  await requireAdmin();
  const days = Number(periodQuery.parse(Object.fromEntries(req.nextUrl.searchParams)).days);
  const args = [String(days), TZ];
  const month = new Date().toISOString().slice(0, 7);

  const [totals, daily, models, accounts, problems, ingestion, failedSources, embedding, alerts] = await Promise.all([
    q1(
      `SELECT
         (SELECT count(*)::int FROM users) AS accounts,
         (SELECT count(*)::int FROM users WHERE created_at >= ${SINCE}) AS new_accounts,
         (SELECT count(*)::int FROM users WHERE plan <> 'free') AS paying_accounts,
         (SELECT count(*)::int FROM agents) AS agents,
         (SELECT count(*)::int FROM conversations WHERE channel <> 'playground' AND created_at >= ${SINCE}) AS conversations,
         (SELECT count(DISTINCT user_id)::int FROM ai_calls WHERE kind = 'answer' AND created_at >= ${SINCE}) AS active_accounts,
         count(*) FILTER (WHERE kind = 'answer')::int AS answers,
         count(*) FILTER (WHERE kind = 'answer' AND status = 'error')::int AS errors,
         count(*) FILTER (WHERE kind = 'answer' AND status = 'partial')::int AS partial,
         count(*) FILTER (WHERE kind = 'answer' AND fallback_used)::int AS fallbacks,
         count(*) FILTER (WHERE kind = 'answer' AND attempts > 1)::int AS retried,
         COALESCE(round(avg(first_token_ms) FILTER (WHERE kind = 'answer' AND status = 'ok'))::int, 0) AS avg_first_token_ms,
         COALESCE(round(percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE kind = 'answer' AND status = 'ok'))::int, 0) AS p95_first_token_ms,
         COALESCE(round(avg(total_ms) FILTER (WHERE kind = 'answer' AND status = 'ok'))::int, 0) AS avg_total_ms,
         COALESCE(sum(input_tokens) FILTER (WHERE kind = 'answer'), 0)::bigint AS input_tokens,
         COALESCE(sum(output_tokens) FILTER (WHERE kind = 'answer'), 0)::bigint AS output_tokens,
         COALESCE(sum(input_tokens) FILTER (WHERE kind = 'ingest'), 0)::bigint AS embed_tokens,
         COALESCE(sum(cost_usd) FILTER (WHERE kind = 'answer'), 0)::float AS answer_cost_usd,
         COALESCE(sum(cost_usd) FILTER (WHERE kind = 'ingest'), 0)::float AS ingest_cost_usd,
         count(*) FILTER (WHERE cost_usd IS NULL AND status <> 'error')::int AS unpriced_calls,
         (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.feedback = 1 AND m.created_at >= ${SINCE}) AS thumbs_up,
         (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.feedback = -1 AND m.created_at >= ${SINCE}) AS thumbs_down,
         (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.knowledge_gap AND c.channel <> 'playground' AND m.created_at >= ${SINCE}) AS gaps
       FROM ai_calls WHERE created_at >= ${SINCE}`,
      args
    ),
    q<{ day: string; answers: number; errors: number; cost_usd: number }>(
      `SELECT to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE kind = 'answer')::int AS answers,
              count(*) FILTER (WHERE kind = 'answer' AND status = 'error')::int AS errors,
              COALESCE(sum(cost_usd), 0)::float AS cost_usd
         FROM ai_calls WHERE created_at >= ${SINCE} GROUP BY 1 ORDER BY 1`,
      args
    ),
    q(
      `SELECT kind, provider, model, count(*)::int AS calls,
              count(*) FILTER (WHERE status = 'error')::int AS errors,
              COALESCE(sum(input_tokens), 0)::bigint AS input_tokens, COALESCE(sum(output_tokens), 0)::bigint AS output_tokens,
              bool_or(tokens_estimated) AS estimated, sum(cost_usd)::float AS cost_usd, bool_or(cost_usd IS NULL AND status <> 'error') AS unpriced,
              round(avg(first_token_ms))::int AS avg_first_token_ms
         FROM ai_calls WHERE created_at >= ${SINCE} GROUP BY 1, 2, 3 ORDER BY calls DESC`,
      args
    ),
    q<{ id: string; email: string; plan: string; credits_used: number } & Record<string, unknown>>(
      `SELECT u.id, u.email, u.name, u.plan, u.created_at,
              (SELECT count(*)::int FROM agents a WHERE a.user_id = u.id) AS agents,
              COALESCE((SELECT used FROM usage WHERE user_id = u.id AND period = $3), 0) AS credits_used,
              (SELECT count(*)::int FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE a.user_id = u.id AND c.channel <> 'playground' AND c.created_at >= ${SINCE}) AS conversations,
              count(k.*) FILTER (WHERE k.kind = 'answer')::int AS answers,
              count(k.*) FILTER (WHERE k.kind = 'answer' AND k.status = 'error')::int AS errors,
              COALESCE(sum(k.input_tokens + k.output_tokens), 0)::bigint AS tokens,
              COALESCE(sum(k.cost_usd), 0)::float AS cost_usd,
              (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = c.agent_id
                WHERE a.user_id = u.id AND m.feedback = -1 AND m.created_at >= ${SINCE}) AS thumbs_down,
              (SELECT max(k2.created_at) FROM ai_calls k2 WHERE k2.user_id = u.id) AS last_active
         FROM users u LEFT JOIN ai_calls k ON k.user_id = u.id AND k.created_at >= ${SINCE}
        GROUP BY u.id ORDER BY answers DESC, u.created_at DESC LIMIT 300`,
      [...args, month]
    ),
    q(
      `SELECT k.id, k.created_at, k.status, k.provider, k.model, k.attempts, k.fallback_used, k.error, k.question, k.first_token_ms, k.total_ms,
              u.email, a.name AS agent_name, k.channel
         FROM ai_calls k JOIN users u ON u.id = k.user_id LEFT JOIN agents a ON a.id = k.agent_id
        WHERE k.kind = 'answer' AND k.created_at >= ${SINCE} AND (k.status <> 'ok' OR k.fallback_used OR k.attempts > 1)
        ORDER BY k.created_at DESC LIMIT 50`,
      args
    ),
    q1(
      `SELECT count(*) FILTER (WHERE status = 'processing' AND (locked_until IS NULL OR locked_until < now()))::int AS queued,
              count(*) FILTER (WHERE status = 'processing' AND locked_until >= now())::int AS running,
              count(*) FILTER (WHERE status = 'processing' AND attempts > 0 AND error LIKE 'Retrying%')::int AS retrying,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'ready')::int AS ready,
              COALESCE(sum(chunk_count) FILTER (WHERE status = 'ready'), 0)::int AS passages
         FROM sources`
    ),
    q(
      `SELECT s.id, s.title, s.type, s.error, s.attempts, s.updated_at, a.name AS agent_name, u.email
         FROM sources s JOIN agents a ON a.id = s.agent_id JOIN users u ON u.id = a.user_id
        WHERE s.status = 'failed' ORDER BY s.updated_at DESC LIMIT 20`
    ),
    q1(
      `SELECT count(*) FILTER (WHERE embedding_model IS NOT NULL AND embedding_model <> $1)::int AS stale,
              count(*) FILTER (WHERE embedding_model IS NULL)::int AS untracked,
              count(*)::int AS total
         FROM chunks`,
      [embeddingModelId()]
    ),
    currentAlerts(),
  ]);

  // Zero-filled daily series, oldest first.
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1 - i));
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return byDay.get(day) ?? { day, answers: 0, errors: 0, cost_usd: 0 };
  });

  const llm = getLLM();
  const fallback = getFallbackLLM();
  return NextResponse.json({
    days,
    usdInr: usdInrRate(),
    config: {
      llm: `${llm.name}:${llm.model}`,
      fallback: fallback ? `${fallback.name}:${fallback.model}` : null,
      embedding: embeddingModelId(),
      pricesConfigured: !!env("LLM_PRICES"),
    },
    totals,
    series,
    models,
    accounts: accounts.map((a) => ({ ...a, credits_limit: planOf(a.plan).credits })),
    problems,
    ingestion: { ...ingestion, failedSources },
    embedding,
    alerts,
  });
});
