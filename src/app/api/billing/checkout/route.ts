import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { PLANS } from "@/lib/plans";
import { LIVE_STATES, PAID_PLANS, razorpayPlanId } from "@/lib/billing";
import { createSubscription, razorpayConfigured } from "@/lib/razorpay";

export const runtime = "nodejs";

const schema = z.object({ plan: z.enum(PAID_PLANS) });

/**
 * Step 1 of upgrading: create a Razorpay subscription for the chosen plan. The browser then opens
 * Razorpay Checkout with the returned subscription id. The price comes from OUR plan table and
 * Razorpay plan id - never from the client.
 */
export const POST = handle(async (req) => {
  const user = await requireUser();
  const { plan } = schema.parse(await req.json());
  if (!razorpayConfigured()) throw new HttpError(503, "Billing isn't set up on this server yet");
  const planId = razorpayPlanId(plan);
  if (!planId) throw new HttpError(503, `The ${PLANS[plan].name} plan isn't available yet`);

  const live = await q1("SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = ANY($2)", [user.id, LIVE_STATES]);
  if (live) throw new HttpError(409, "You already have an active subscription. Cancel it first to switch plans.");

  const sub = await createSubscription(planId, { user_id: user.id, plan });
  await q("INSERT INTO subscriptions (user_id, razorpay_subscription_id, plan, status) VALUES ($1,$2,$3,'created')", [user.id, sub.id, plan]);
  return NextResponse.json({ subscriptionId: sub.id, keyId: process.env.RAZORPAY_KEY_ID, plan, planName: PLANS[plan].name });
});
