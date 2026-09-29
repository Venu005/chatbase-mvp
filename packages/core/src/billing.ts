import { q, q1 } from "./db";
import { PLANS, type PlanId } from "./plans";

export const PAID_PLANS = ["starter", "growth", "pro"] as const satisfies readonly PlanId[];
export type PaidPlan = (typeof PAID_PLANS)[number];

export const isPaidPlan = (s: unknown): s is PaidPlan => typeof s === "string" && (PAID_PLANS as readonly string[]).includes(s);

/** Razorpay plan ids are created once (pnpm razorpay:setup) and configured as RAZORPAY_PLAN_STARTER etc. */
export const razorpayPlanId = (plan: PaidPlan): string | null => process.env[`RAZORPAY_PLAN_${plan.toUpperCase()}`] || null;

export const planAmountPaise = (plan: PaidPlan) => PLANS[plan].priceInr * 100;

/** Subscription states in which the customer is (or is about to be) paying. */
export const LIVE_STATES = ["authenticated", "active", "pending"];
const TERMINAL_STATES = ["cancelled", "completed"];

export type SubRow = {
  id: string;
  user_id: string;
  razorpay_subscription_id: string;
  plan: string;
  status: string;
  current_end: string | null;
  cancel_at_period_end: boolean;
};

type WebhookBody = {
  event?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: { subscription?: { entity?: any } };
};

async function setPlanIfNoOtherLive(userId: string, exceptSubId: string, plan: string) {
  await q(
    `UPDATE users SET plan = $3 WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE user_id = $1 AND id <> $2 AND status = ANY($4))`,
    [userId, exceptSubId, plan, LIVE_STATES]
  );
}

/**
 * Applies one verified Razorpay subscription webhook. This is the ONLY code that changes users.plan
 * (besides manual SQL), so a customer can't get a paid plan without Razorpay confirming payment.
 * Returns a short description of what happened (useful for logs/tests).
 */
export async function applyBillingEvent(body: WebhookBody): Promise<string> {
  const event = body.event ?? "";
  const ent = body.payload?.subscription?.entity;
  if (!event.startsWith("subscription.") || !ent?.id) return "ignored: not a subscription event";

  const sub = await q1<SubRow>("SELECT * FROM subscriptions WHERE razorpay_subscription_id = $1", [ent.id]);
  if (!sub) return "ignored: unknown subscription";

  // Defence in depth: the subscription must be for the plan we created it for.
  const expectedPlanId = isPaidPlan(sub.plan) ? razorpayPlanId(sub.plan) : null;
  if (expectedPlanId && ent.plan_id && ent.plan_id !== expectedPlanId) return "ignored: plan mismatch";

  const currentEnd = typeof ent.current_end === "number" ? new Date(ent.current_end * 1000).toISOString() : sub.current_end;
  const set = (status: string, extra = "") =>
    q(`UPDATE subscriptions SET status = $2, current_end = $3, updated_at = now() ${extra} WHERE id = $1`, [sub.id, status, currentEnd]);

  // A late "charged/activated" must not resurrect a subscription that already ended.
  if (TERMINAL_STATES.includes(sub.status) && ["subscription.activated", "subscription.charged", "subscription.resumed", "subscription.authenticated"].includes(event)) {
    return `ignored: ${event} after ${sub.status}`;
  }

  switch (event) {
    case "subscription.authenticated":
      if (sub.status === "created") await set("authenticated");
      return "authenticated";
    case "subscription.activated":
    case "subscription.charged":
    case "subscription.resumed":
      await set("active");
      await q("UPDATE users SET plan = $2 WHERE id = $1", [sub.user_id, sub.plan]);
      return `plan ${sub.plan} active`;
    case "subscription.updated":
      await set(sub.status);
      return "updated";
    case "subscription.pending": // a renewal payment failed; Razorpay is retrying. Keep the plan for now.
      await set("pending");
      return "pending (renewal retry)";
    case "subscription.paused":
      await set("paused");
      await setPlanIfNoOtherLive(sub.user_id, sub.id, "free");
      return "paused → free";
    case "subscription.halted": // retries exhausted
    case "subscription.cancelled":
    case "subscription.completed": {
      const status = event.split(".")[1];
      await set(status, ", cancel_at_period_end = false");
      await setPlanIfNoOtherLive(sub.user_id, sub.id, "free");
      return `${status} → free`;
    }
    default:
      return `ignored: ${event}`;
  }
}
