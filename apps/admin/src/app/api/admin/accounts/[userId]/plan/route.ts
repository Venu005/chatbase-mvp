import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { HttpError, handle } from "@chatbase/core/http";
import { audit } from "@/lib/admin";
import { PLANS } from "@chatbase/core/plans";
import { LIVE_STATES } from "@chatbase/core/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ userId: string }> };

const schema = z.object({
  plan: z.enum(Object.keys(PLANS) as [keyof typeof PLANS, ...(keyof typeof PLANS)[]]),
  reason: z.string().trim().min(3, "Say why (for the audit log)").max(300),
});

/**
 * Sets an account's plan by hand (a trial, a partner, a goodwill upgrade). Such plans are "comped": they aren't
 * counted as revenue, and the next Razorpay payment event for the account replaces them.
 */
export const POST = handle<Ctx>(async (req, { params }) => {
  const me = await requireAdmin();
  const userId = (await params).userId;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(404, "Account not found");
  const { plan, reason } = schema.parse(await req.json());
  const before = await q1<{ email: string; plan: string; plan_comped: boolean; live: boolean }>(
    `SELECT email, plan, plan_comped, EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = ANY($2)) AS live
       FROM users u WHERE id = $1`,
    [userId, LIVE_STATES]
  );
  if (!before) throw new HttpError(404, "Account not found");
  await q1("UPDATE users SET plan = $2, plan_comped = $3 WHERE id = $1", [userId, plan, plan !== "free"]);
  await audit(me, "plan.change", { id: userId, email: before.email }, { from: before.plan, to: plan, reason, had_live_subscription: before.live });
  return NextResponse.json({
    plan,
    comped: plan !== "free",
    warning: before.live ? "This account has a live Razorpay subscription: its next payment event will set the plan back to the paid one." : null,
  });
});
