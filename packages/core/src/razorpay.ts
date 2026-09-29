import { hmacSha256Hex, safeEqual } from "./crypto";
import { HttpError } from "./http";
import { env, envStr } from "./env";

// Razorpay Subscriptions. Docs: POST /v1/subscriptions {plan_id, total_count, notes}, Basic auth (key id : key secret);
// Checkout success returns razorpay_payment_id / razorpay_subscription_id / razorpay_signature where
// signature = HMAC-SHA256(payment_id + "|" + subscription_id, key secret);
// webhooks carry X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret) and a unique X-Razorpay-Event-Id.

const base = () => envStr("RAZORPAY_API_BASE", "https://api.razorpay.com").replace(/\/$/, "");

export const razorpayConfigured = () => !!(env("RAZORPAY_KEY_ID") && env("RAZORPAY_KEY_SECRET"));

async function rz<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const id = env("RAZORPAY_KEY_ID");
  const secret = env("RAZORPAY_KEY_SECRET");
  if (!id || !secret) throw new HttpError(503, "Billing isn't set up on this server yet");
  const res = await fetch(`${base()}/v1${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    console.error("Razorpay API error:", res.status, JSON.stringify(j));
    throw new HttpError(502, `Razorpay error: ${j?.error?.description ?? `HTTP ${res.status}`}`);
  }
  return (await res.json()) as T;
}

export type RzSubscription = { id: string; plan_id: string; status: string; current_end?: number | null; short_url?: string };
export type RzPlan = { id: string; period: string; interval: number; item: { name: string; amount: number; currency: string } };

/** Monthly plan, billed until cancelled (10 years of cycles). */
export const createSubscription = (planId: string, notes: Record<string, string>) =>
  rz<RzSubscription>("POST", "/subscriptions", { plan_id: planId, total_count: 120, customer_notify: true, notes });

/** atCycleEnd=true keeps the paid plan until the end of the current billing period. */
export const cancelSubscription = (subscriptionId: string, atCycleEnd: boolean) =>
  rz<RzSubscription>("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { cancel_at_cycle_end: atCycleEnd });

export const listPlans = () => rz<{ items: RzPlan[] }>("GET", "/plans?count=100");
export const createPlan = (name: string, amountPaise: number, description: string) =>
  rz<RzPlan>("POST", "/plans", { period: "monthly", interval: 1, item: { name, amount: amountPaise, currency: "INR", description } });

export function verifyCheckoutSignature(paymentId: string, subscriptionId: string, signature: string): boolean {
  const secret = env("RAZORPAY_KEY_SECRET");
  if (!secret) return false;
  return safeEqual(signature, hmacSha256Hex(secret, `${paymentId}|${subscriptionId}`));
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string | null): boolean {
  const secret = env("RAZORPAY_WEBHOOK_SECRET");
  if (!secret || !signature) return false;
  return safeEqual(signature, hmacSha256Hex(secret, rawBody));
}
