import { NextResponse } from "next/server";
import { q1 } from "@chatbase/core/db";
import { requireUser } from "@chatbase/core/auth";
import { handle } from "@chatbase/core/http";
import { PLANS, planOf } from "@chatbase/core/plans";
import { getUsage } from "@chatbase/core/usage";
import { LIVE_STATES, PAID_PLANS, razorpayPlanId, type SubRow } from "@chatbase/core/billing";
import { razorpayConfigured } from "@chatbase/core/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the billing page needs: current plan, usage, live subscription and the plan catalogue. */
export const GET = handle(async () => {
  const user = await requireUser();
  const sub = await q1<SubRow>(
    "SELECT * FROM subscriptions WHERE user_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1",
    [user.id, LIVE_STATES]
  );
  return NextResponse.json({
    configured: razorpayConfigured(),
    email: user.email,
    name: user.name,
    plan: { id: user.plan, name: planOf(user.plan).name },
    usage: await getUsage(user.id, user.plan),
    subscription: sub && {
      plan: sub.plan,
      status: sub.status,
      currentEnd: sub.current_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
    plans: [
      { id: "free", ...PLANS.free, available: true },
      ...PAID_PLANS.map((id) => ({ id, ...PLANS[id], available: !!razorpayPlanId(id) })),
    ],
  });
});
