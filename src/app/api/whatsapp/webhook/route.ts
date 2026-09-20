import { NextRequest, NextResponse } from "next/server";
import { q1 } from "@/lib/db";
import { safeEqual } from "@/lib/crypto";
import { handle } from "@/lib/http";
import { metaApp } from "@/lib/meta";
import { extractIncoming, processInBackground, verifySignature, type Channel } from "@/lib/whatsapp";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The platform-level webhook for numbers connected through Embedded Signup. Set this URL ONCE in your
 * Meta app (WhatsApp > Configuration) with WHATSAPP_WEBHOOK_VERIFY_TOKEN as the verify token; messages
 * for every customer's number arrive here and are routed to the right agent by phone number id.
 */
export const GET = handle(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const expected = env("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
  const challenge = sp.get("hub.challenge");
  if (expected && sp.get("hub.mode") === "subscribe" && challenge !== null && safeEqual(sp.get("hub.verify_token") ?? "", expected)) {
    return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new NextResponse("Forbidden", { status: 403 });
});

export const POST = handle(async (req: NextRequest) => {
  const app = metaApp();
  if (!app) return new NextResponse("Not configured", { status: 404 });

  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), app.appSecret)) return new NextResponse("Invalid signature", { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }

  const incoming = extractIncoming(payload);
  const pairs: { channel: Channel; message: (typeof incoming)[number] }[] = [];
  const cache = new Map<string, Channel | null>();
  for (const message of incoming) {
    if (!cache.has(message.phoneNumberId)) {
      // Only numbers connected through Embedded Signup are served here; manual channels have their own URL.
      cache.set(message.phoneNumberId, await q1<Channel>("SELECT * FROM whatsapp_channels WHERE phone_number_id = $1 AND source = 'embedded'", [message.phoneNumberId]));
    }
    const channel = cache.get(message.phoneNumberId);
    if (channel) pairs.push({ channel, message });
  }
  processInBackground(pairs);
  return NextResponse.json({ ok: true });
});
