// Placeholder plans and INR prices - tune these to your own unit economics.
// A "credit" is one AI reply. Billing is not wired up in this MVP: change a
// user's plan with SQL (UPDATE users SET plan='starter' WHERE email=...) or
// add Razorpay subscriptions (see README roadmap).
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
