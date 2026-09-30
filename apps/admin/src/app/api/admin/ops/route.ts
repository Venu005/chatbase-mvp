import { NextResponse } from "next/server";
import { q, q1 } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@chatbase/core/http";
import { SINCE, TZ, periodQuery } from "@/lib/admin";
import { currentAlerts } from "@chatbase/core/ops-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operations: per-day answer volume, failure rate and speed for each model provider, the answer-cache hit rate,
 * ingestion speed, and the alerts that are firing now (plus the last ones e-mailed).
 */
export const GET = handle(async (req) => {
  await requireAdmin();
  const days = periodQuery.parse(Object.fromEntries(req.nextUrl.searchParams)).days;
  const args = [days, TZ];

  const [providers, cache, ingestion, alerts, sent] = await Promise.all([
    q<{ day: string; provider: string; calls: number; errors: number; fallbacks: number; p50_ms: number | null; p95_ms: number | null }>(
      `SELECT to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, provider, count(*)::int AS calls,
              count(*) FILTER (WHERE status = 'error')::int AS errors,
              count(*) FILTER (WHERE fallback_used)::int AS fallbacks,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE status = 'ok'))::int AS p50_ms,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE status = 'ok'))::int AS p95_ms
         FROM ai_calls WHERE kind = 'answer' AND provider <> 'cache' AND created_at >= ${SINCE}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      args
    ),
    q<{ day: string; answers: number; cached: number }>(
      `SELECT to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, count(*)::int AS answers,
              count(*) FILTER (WHERE provider = 'cache')::int AS cached
         FROM ai_calls WHERE kind = 'answer' AND channel <> 'playground' AND created_at >= ${SINCE} GROUP BY 1 ORDER BY 1`,
      args
    ),
    q1<{ added: number; ready: number; failed: number; p50_seconds: number | null; p95_seconds: number | null }>(
      `SELECT count(*)::int AS added,
              count(*) FILTER (WHERE status = 'ready')::int AS ready,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM last_synced_at - created_at)) FILTER (WHERE status = 'ready'))::int AS p50_seconds,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM last_synced_at - created_at)) FILTER (WHERE status = 'ready'))::int AS p95_seconds
         FROM sources WHERE created_at >= ${SINCE}`,
      args
    ),
    currentAlerts(),
    q("SELECT key, last_sent_at, last_message FROM ops_alerts ORDER BY last_sent_at DESC LIMIT 20"),
  ]);

  const totals = new Map<string, { provider: string; calls: number; errors: number; fallbacks: number }>();
  for (const p of providers) {
    const t = totals.get(p.provider) ?? totals.set(p.provider, { provider: p.provider, calls: 0, errors: 0, fallbacks: 0 }).get(p.provider)!;
    t.calls += p.calls;
    t.errors += p.errors;
    t.fallbacks += p.fallbacks;
  }
  const answers = cache.reduce((t, c) => t + c.answers, 0);
  const cached = cache.reduce((t, c) => t + c.cached, 0);
  return NextResponse.json({
    days: Number(days),
    providers: [...totals.values()].sort((a, b) => b.calls - a.calls),
    daily: providers,
    cache: { answers, cached, rate: answers ? cached / answers : 0, daily: cache },
    ingestion,
    alerts,
    sent,
  });
});
