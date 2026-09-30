import { NextResponse } from "next/server";
import { q, q1 } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@chatbase/core/http";
import { SINCE, TZ, periodQuery } from "@/lib/admin";
import { planOf } from "@chatbase/core/plans";
import { churnRisk } from "@chatbase/core/insights";
import { period } from "@chatbase/core/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEEKS = 8;

/**
 * Growth: the signup → paid funnel for accounts that signed up in the period, weekly cohorts (share of each signup
 * week still getting real conversations N weeks later), paying accounts at risk of leaving, and accounts about to
 * run out of credits (upgrade candidates). "Real" conversations exclude the owner's own playground tests.
 */
export const GET = handle(async (req) => {
  await requireAdmin();
  const days = periodQuery.parse(Object.fromEntries(req.nextUrl.searchParams)).days;
  const args = [days, TZ];

  const [funnel, cohortUsers, activity, risk, credits, current] = await Promise.all([
    q1<Record<string, number>>(
      `SELECT count(*)::int AS signups,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a WHERE a.user_id = u.id))::int AS created_agent,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a JOIN sources s ON s.agent_id = a.id WHERE a.user_id = u.id AND s.status = 'ready')
                                  OR EXISTS (SELECT 1 FROM agents a JOIN answer_fixes f ON f.agent_id = a.id WHERE a.user_id = u.id))::int AS added_knowledge,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a JOIN conversations c ON c.agent_id = a.id WHERE a.user_id = u.id AND c.channel <> 'playground'))::int AS went_live,
              count(*) FILTER (WHERE u.plan <> 'free' AND NOT u.plan_comped)::int AS paid
         FROM users u WHERE u.created_at >= ${SINCE}`,
      args
    ),
    q<{ id: string; wk: string }>(
      `SELECT id, to_char(date_trunc('week', created_at AT TIME ZONE $1), 'YYYY-MM-DD') AS wk FROM users
        WHERE created_at >= (date_trunc('week', now() AT TIME ZONE $1) - make_interval(weeks => $2 - 1)) AT TIME ZONE $1`,
      [TZ, WEEKS]
    ),
    q<{ user_id: string; wk: string }>(
      `SELECT DISTINCT user_id, to_char(date_trunc('week', created_at AT TIME ZONE $1), 'YYYY-MM-DD') AS wk FROM ai_calls
        WHERE kind = 'answer' AND channel <> 'playground'
          AND created_at >= (date_trunc('week', now() AT TIME ZONE $1) - make_interval(weeks => $2 - 1)) AT TIME ZONE $1`,
      [TZ, WEEKS]
    ),
    q<{
      id: string;
      email: string;
      plan: string;
      sub_status: string | null;
      cancel_at_period_end: boolean | null;
      last14: number;
      prev14: number;
      last_answer: string | null;
      answers30: number;
      gaps30: number;
      up30: number;
      down30: number;
    }>(
      `SELECT u.id, u.email, u.plan, s.status AS sub_status, s.cancel_at_period_end,
              count(k.*) FILTER (WHERE k.created_at >= now() - interval '14 days')::int AS last14,
              count(k.*) FILTER (WHERE k.created_at < now() - interval '14 days')::int AS prev14,
              (SELECT max(created_at) FROM ai_calls WHERE user_id = u.id AND kind = 'answer' AND channel <> 'playground') AS last_answer,
              (SELECT count(*)::int FROM ai_calls WHERE user_id = u.id AND kind = 'answer' AND channel <> 'playground' AND created_at >= now() - interval '30 days') AS answers30,
              (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = c.agent_id
                WHERE a.user_id = u.id AND m.knowledge_gap AND c.channel <> 'playground' AND m.created_at >= now() - interval '30 days') AS gaps30,
              (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = c.agent_id
                WHERE a.user_id = u.id AND m.feedback = 1 AND m.created_at >= now() - interval '30 days') AS up30,
              (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = c.agent_id
                WHERE a.user_id = u.id AND m.feedback = -1 AND m.created_at >= now() - interval '30 days') AS down30
         FROM users u
         LEFT JOIN LATERAL (SELECT status, cancel_at_period_end FROM subscriptions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) s ON true
         LEFT JOIN ai_calls k ON k.user_id = u.id AND k.kind = 'answer' AND k.channel <> 'playground' AND k.created_at >= now() - interval '28 days'
        WHERE u.plan <> 'free' AND NOT u.plan_comped
        GROUP BY u.id, s.status, s.cancel_at_period_end`
    ),
    q<{ id: string; email: string; plan: string; used: number; bonus: number }>(
      `SELECT u.id, u.email, u.plan, g.used, g.bonus FROM usage g JOIN users u ON u.id = g.user_id WHERE g.period = $1 AND g.used > 0`,
      [period()]
    ),
    q1<{ wk: string }>("SELECT to_char(date_trunc('week', now() AT TIME ZONE $1), 'YYYY-MM-DD') AS wk", [TZ]),
  ]);

  // Weekly cohorts: for each signup week, the share of its accounts with real conversations 0, 1, 2... weeks later.
  const weekMs = 7 * 86_400_000;
  const activeWeeks = new Map<string, Set<string>>();
  for (const a of activity) (activeWeeks.get(a.user_id) ?? activeWeeks.set(a.user_id, new Set()).get(a.user_id)!).add(a.wk);
  const byWeek = new Map<string, string[]>();
  for (const u of cohortUsers) (byWeek.get(u.wk) ?? byWeek.set(u.wk, []).get(u.wk)!).push(u.id);
  const thisWeek = current!.wk;
  const cohorts = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, ids]) => {
      const elapsed = Math.round((Date.parse(thisWeek) - Date.parse(week)) / weekMs);
      const retention = Array.from({ length: elapsed + 1 }, (_, i) => {
        const wk = new Date(Date.parse(week) + i * weekMs).toISOString().slice(0, 10);
        return ids.filter((id) => activeWeeks.get(id)?.has(wk)).length / ids.length;
      });
      return { week, size: ids.length, retention };
    });

  // Churn risk among paying accounts.
  const now = Date.now();
  const atRisk = risk
    .map((r) => {
      const rated = r.up30 + r.down30;
      const res = churnRisk({
        subscriptionStatus: r.sub_status,
        cancelAtPeriodEnd: !!r.cancel_at_period_end,
        answersLast14: r.last14,
        answersPrev14: r.prev14,
        daysSinceLastAnswer: r.last_answer ? Math.floor((now - Date.parse(r.last_answer)) / 86_400_000) : null,
        gapRate: r.answers30 ? r.gaps30 / r.answers30 : 0,
        thumbsDownRate: rated >= 3 ? r.down30 / rated : 0,
      });
      return { id: r.id, email: r.email, plan: r.plan, mrr_inr: planOf(r.plan).priceInr, last14: r.last14, prev14: r.prev14, ...res };
    })
    .filter((r) => r.level !== "low")
    .sort((a, b) => b.points - a.points || b.mrr_inr - a.mrr_inr);

  // Upgrade candidates: 80%+ of this month's credits used, or on course to run out before the month ends.
  const d = new Date();
  const dayOfMonth = d.getUTCDate() + d.getUTCHours() / 24;
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const upgrade = credits
    .map((c) => {
      const limit = planOf(c.plan).credits + c.bonus;
      const projected = Math.max(c.used, Math.round((c.used / Math.min(dayOfMonth, daysInMonth)) * daysInMonth));
      return { id: c.id, email: c.email, plan: c.plan, used: c.used, limit, share: c.used / limit, projected };
    })
    .filter((c) => c.plan !== "pro" && (c.share >= 0.8 || c.projected > c.limit))
    .sort((a, b) => b.share - a.share)
    .slice(0, 100);

  return NextResponse.json({ days: Number(days), funnel, cohorts, atRisk, upgrade });
});
