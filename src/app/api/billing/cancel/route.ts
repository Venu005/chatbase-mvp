import { NextResponse } from "next/server";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { LIVE_STATES, type SubRow } from "@/lib/billing";
import { cancelSubscription } from "@/lib/razorpay";

export const runtime = "nodejs";

/**
 * Cancel the current subscription. If a paid billing cycle is running, the customer keeps the plan until
 * it ends (the webhook then moves them to Free). If checkout never completed, it is cancelled immediately.
 */
export const POST = handle(async () => {
  const user = await requireUser();
  const sub = await q1<SubRow>("SELECT * FROM subscriptions WHERE user_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1", [user.id, LIVE_STATES]);
  if (!sub) throw new HttpError(404, "You don't have an active subscription");

  const atCycleEnd = sub.status === "active" || sub.status === "pending";
  await cancelSubscription(sub.razorpay_subscription_id, atCycleEnd);
  if (atCycleEnd) {
    await q("UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE id = $1", [sub.id]);
  } else {
    await q("UPDATE subscriptions SET status = 'cancelled', updated_at = now() WHERE id = $1", [sub.id]);
  }
  return NextResponse.json({ ok: true, cancelAtPeriodEnd: atCycleEnd });
});
