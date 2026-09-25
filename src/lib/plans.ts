// Placeholder plans and INR prices - tune these to your own unit economics.
// A "credit" is one AI reply. Paid plans are sold through Razorpay subscriptions
// (src/lib/billing.ts, docs/billing-razorpay.md); users.plan changes only on
// Razorpay's signed webhook, or manually with SQL.
export const PLANS = {
  free: { name: "Free", priceInr: 0, credits: 50, agents: 1 },
  starter: { name: "Starter", priceInr: 999, credits: 1000, agents: 3 },
  growth: { name: "Growth", priceInr: 2999, credits: 5000, agents: 10 },
  pro: { name: "Pro", priceInr: 7999, credits: 20000, agents: 30 },
} as const;

export type PlanId = keyof typeof PLANS;

export function planOf(id: string) {
  return PLANS[(id in PLANS ? id : "free") as PlanId];
}
