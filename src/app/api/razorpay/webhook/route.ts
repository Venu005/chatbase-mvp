import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { handle } from "@/lib/http";
import { applyBillingEvent } from "@/lib/billing";
import { verifyWebhookSignature } from "@/lib/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Razorpay webhook. Configure it in Razorpay Dashboard → Settings → Webhooks with the subscription events
 * (authenticated, activated, charged, pending, halted, cancelled, completed, paused, resumed, updated)
 * and the same secret as RAZORPAY_WEBHOOK_SECRET.
 * The signature is checked against the RAW body before anything is parsed or trusted.
 */
export const POST = handle(async (req) => {
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"))) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let body: { event?: string };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }

  // Idempotency: Razorpay can deliver the same event more than once.
  const eventId = req.headers.get("x-razorpay-event-id");
  if (eventId) {
    const fresh = await q("INSERT INTO billing_events (event_id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id", [eventId, body.event ?? "unknown"]);
    if (!fresh.length) return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    const result = await applyBillingEvent(body);
    console.log(`Razorpay ${body.event}: ${result}`);
  } catch (e) {
    // Let Razorpay retry: forget the event id so the retry is processed.
    if (eventId) await q("DELETE FROM billing_events WHERE event_id = $1", [eventId]).catch(() => {});
    throw e;
  }
  return NextResponse.json({ ok: true });
});
