import { NextRequest, NextResponse } from "next/server";
import { q1 } from "@/lib/db";
import { safeEqual } from "@/lib/crypto";
import { handle } from "@/lib/http";
import { channelAppSecret, extractIncoming, processInBackground, verifySignature, type Channel } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ channelId: string }> };

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
const loadChannel = (id: string) => (isUuid(id) ? q1<Channel>("SELECT * FROM whatsapp_channels WHERE id = $1", [id]) : Promise.resolve(null));

/** Meta's one-time webhook verification handshake. */
export const GET = handle<Ctx>(async (req: NextRequest, { params }) => {
  const ch = await loadChannel((await params).channelId);
  const sp = req.nextUrl.searchParams;
  const challenge = sp.get("hub.challenge");
  if (ch && sp.get("hub.mode") === "subscribe" && challenge !== null && safeEqual(sp.get("hub.verify_token") ?? "", ch.verify_token)) {
    return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new NextResponse("Forbidden", { status: 403 });
});

/**
 * Incoming messages. Order matters: verify the signature on the RAW body first, answer 200 quickly
 * (Meta retries slow or failed deliveries for days and delivers at-least-once), then process in the
 * background, skipping message ids we've already seen.
 */
export const POST = handle<Ctx>(async (req, { params }) => {
  const ch = await loadChannel((await params).channelId);
  if (!ch) return new NextResponse("Not found", { status: 404 });

  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), channelAppSecret(ch))) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }

  processInBackground(extractIncoming(payload).filter((m) => m.phoneNumberId === ch.phone_number_id).map((message) => ({ channel: ch, message })));
  return NextResponse.json({ ok: true });
});
