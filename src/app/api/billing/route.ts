import { NextResponse } from "next/server";
import { q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { PLANS, planOf } from "@/lib/plans";
import { getUsage } from "@/lib/usage";
import { LIVE_STATES, PAID_PLANS, razorpayPlanId, type SubRow } from "@/lib/billing";
import { razorpayConfigured } from "@/lib/razorpay";

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
