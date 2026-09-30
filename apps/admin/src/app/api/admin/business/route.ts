import { NextResponse } from "next/server";
import { q } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@chatbase/core/http";
import { SINCE, TZ, periodQuery, profitRate } from "@/lib/admin";
import { PLANS, planOf } from "@chatbase/core/plans";
import { LIVE_STATES } from "@chatbase/core/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  email: string;
  plan: string;
  plan_comped: boolean;
  created_at: string;
  sub_status: string | null;
  cancel_at_period_end: boolean | null;
  cost_usd: number;
  answers: number;
};

/**
 * Revenue and unit economics: MRR/ARR from paid plans (admin-granted "comped" plans don't count), the plan mix, and
 * each account's profit over the last 30 days (plan price minus AI cost), so unprofitable accounts stand out.
 */
export const GET = handle(async (req) => {
  await requireAdmin();
  const days = periodQuery.parse(Object.fromEntries(req.nextUrl.searchParams)).days;
  const { rate, assumed } = profitRate();

  const [rows, moves] = await Promise.all([
    q<Row>(
      `SELECT u.id, u.email, u.plan, u.plan_comped, u.created_at, s.status AS sub_status, s.cancel_at_period_end,
              COALESCE(k.cost_usd, 0)::float AS cost_usd, COALESCE(k.answers, 0)::int AS answers
         FROM users u
         LEFT JOIN LATERAL (SELECT status, cancel_at_period_end FROM subscriptions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) s ON true
         LEFT JOIN (SELECT user_id, sum(cost_usd) AS cost_usd, count(*) FILTER (WHERE kind = 'answer') AS answers
                      FROM ai_calls WHERE created_at >= now() - interval '30 days' GROUP BY user_id) k ON k.user_id = u.id`
    ),
    q<{ new_paid: number; churned: number }>(
      `SELECT count(*) FILTER (WHERE status = ANY($3) AND created_at >= ${SINCE})::int AS new_paid,
              count(*) FILTER (WHERE status IN ('cancelled', 'halted', 'completed') AND updated_at >= ${SINCE})::int AS churned
         FROM subscriptions`,
      [days, TZ, LIVE_STATES]
    ),
  ]);

  const paying = (r: Row) => r.plan !== "free" && !r.plan_comped;
  const accounts = rows.map((r) => {
    const revenue = paying(r) ? planOf(r.plan).priceInr : 0;
    const cost = Math.round(r.cost_usd * rate * 100) / 100;
    return {
      id: r.id,
      email: r.email,
      plan: r.plan,
      comped: r.plan_comped,
      subscription: r.sub_status,
      answers: r.answers,
      revenue_inr: revenue,
      cost_inr: cost,
      profit_inr: Math.round((revenue - cost) * 100) / 100,
      margin: revenue ? (revenue - cost) / revenue : null,
      at_risk: paying(r) && (!!r.cancel_at_period_end || r.sub_status === "pending" || r.sub_status === "halted"),
    };
  });

  const mrr = accounts.reduce((t, a) => t + a.revenue_inr, 0);
  const cost30 = accounts.reduce((t, a) => t + a.cost_inr, 0);
  const planMix = (Object.keys(PLANS) as (keyof typeof PLANS)[]).map((plan) => {
    const on = accounts.filter((a) => a.plan === plan);
    const cost = on.reduce((t, a) => t + a.cost_inr, 0);
    const revenue = on.reduce((t, a) => t + a.revenue_inr, 0);
    return {
      plan,
      name: PLANS[plan].name,
      price_inr: PLANS[plan].priceInr,
      accounts: on.length,
      paying: on.filter((a) => a.revenue_inr > 0).length,
      comped: on.filter((a) => a.comped).length,
      mrr_inr: revenue,
      cost_inr: Math.round(cost * 100) / 100,
      avg_cost_inr: on.length ? Math.round((cost / on.length) * 100) / 100 : 0,
      margin: revenue ? (revenue - cost) / revenue : null,
    };
  });

  return NextResponse.json({
    rate,
    rateAssumed: assumed,
    mrr_inr: mrr,
    arr_inr: mrr * 12,
    paying_accounts: accounts.filter((a) => a.revenue_inr > 0).length,
    comped_accounts: accounts.filter((a) => a.comped).length,
    arpa_inr: accounts.some((a) => a.revenue_inr > 0) ? Math.round(mrr / accounts.filter((a) => a.revenue_inr > 0).length) : 0,
    ai_cost_30d_inr: Math.round(cost30 * 100) / 100,
    gross_margin: mrr ? (mrr - cost30) / mrr : null,
    revenue_at_risk_inr: accounts.filter((a) => a.at_risk).reduce((t, a) => t + a.revenue_inr, 0),
    new_paid: moves[0].new_paid,
    churned: moves[0].churned,
    planMix,
    // Worst first: accounts losing money, then the thinnest margins. Accounts with neither revenue nor cost are left out.
    accounts: accounts
      .filter((a) => a.revenue_inr > 0 || a.cost_inr > 0)
      .sort((a, b) => a.profit_inr - b.profit_inr)
      .slice(0, 200),
    unprofitable: accounts.filter((a) => a.profit_inr < 0).length,
  });
});
