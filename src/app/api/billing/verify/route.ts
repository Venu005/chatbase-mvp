import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { verifyCheckoutSignature } from "@/lib/razorpay";

export const runtime = "nodejs";

const schema = z.object({
  razorpay_payment_id: z.string().min(5).max(100),
  razorpay_subscription_id: z.string().min(5).max(100),
  razorpay_signature: z.string().min(10).max(200),
});

/**
 * Step 2: after Checkout succeeds in the browser, confirm the payment signature. This only proves the
 * checkout result wasn't forged. The plan itself is upgraded by the Razorpay webhook (the source of truth).
 */
export const POST = handle(async (req) => {
  const user = await requireUser();
  const b = schema.parse(await req.json());
  const sub = await q1<{ id: string }>("SELECT id FROM subscriptions WHERE razorpay_subscription_id = $1 AND user_id = $2", [b.razorpay_subscription_id, user.id]);
  if (!sub) throw new HttpError(404, "Subscription not found");
  if (!verifyCheckoutSignature(b.razorpay_payment_id, b.razorpay_subscription_id, b.razorpay_signature)) {
    throw new HttpError(400, "Payment verification failed");
  }
  await q("UPDATE subscriptions SET status = 'authenticated', updated_at = now() WHERE id = $1 AND status = 'created'", [sub.id]);
  return NextResponse.json({ verified: true });
});
