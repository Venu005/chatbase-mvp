import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { decryptSecret, encryptSecret, randomToken } from "@/lib/crypto";
import { HttpError, handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";
import { fetchPhoneInfo } from "@/lib/whatsapp";
import { embeddedSignupPublic, unsubscribeApp } from "@/lib/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type Row = {
  id: string;
  phone_number_id: string;
  display_phone_number: string;
  verified_name: string;
  verify_token: string;
  last_message_at: string | null;
  source: "manual" | "embedded";
  waba_id: string | null;
};

function origin(req: NextRequest): string {
  return (process.env.APP_URL || req.nextUrl.origin).replace(/\/$/, "");
}

/** Secrets (access token, app secret) are never returned - only what the owner needs to finish setup in Meta. */
function view(req: NextRequest, row: Row | null) {
  const embedded = embeddedSignupPublic();
  if (!row) return { connected: false, embedded };
  return {
    connected: true,
    embedded,
    source: row.source,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    // Embedded Signup numbers use the platform's single webhook, so the owner has nothing to configure in Meta.
    ...(row.source === "manual" ? { webhookUrl: `${origin(req)}/api/whatsapp/webhook/${row.id}`, verifyToken: row.verify_token } : {}),
    lastMessageAt: row.last_message_at,
  };
}

const SELECT =
  "SELECT id, phone_number_id, display_phone_number, verified_name, verify_token, last_message_at, source, waba_id FROM whatsapp_channels WHERE agent_id = $1";

export const GET = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  return NextResponse.json(view(req, await q1<Row>(SELECT, [agent.id])));
});

const connect = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "Phone number ID should be digits only"),
  accessToken: z.string().trim().min(20, "Paste the access token").max(1000),
  appSecret: z.string().trim().min(8, "Paste the app secret").max(200),
});

export const PUT = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const b = connect.parse(await req.json());

  const info = await fetchPhoneInfo(b.phoneNumberId, b.accessToken); // proves the token really controls this number
  const other = await q1("SELECT 1 FROM whatsapp_channels WHERE phone_number_id = $1 AND agent_id <> $2", [b.phoneNumberId, agent.id]);
  if (other) throw new HttpError(409, "This WhatsApp number is already connected to another agent");

  const row = await q1<Row>(
    `INSERT INTO whatsapp_channels (agent_id, phone_number_id, display_phone_number, verified_name, access_token_enc, app_secret_enc, verify_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (agent_id) DO UPDATE SET phone_number_id = EXCLUDED.phone_number_id,
       display_phone_number = EXCLUDED.display_phone_number, verified_name = EXCLUDED.verified_name,
       access_token_enc = EXCLUDED.access_token_enc, app_secret_enc = EXCLUDED.app_secret_enc, source = 'manual', waba_id = NULL
     RETURNING id, phone_number_id, display_phone_number, verified_name, verify_token, last_message_at, source, waba_id`,
    [agent.id, b.phoneNumberId, info.display_phone_number, info.verified_name, encryptSecret(b.accessToken), encryptSecret(b.appSecret), randomToken()]
  );
  return NextResponse.json(view(req, row));
});

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const ch = await q1<{ source: string; waba_id: string | null; access_token_enc: string }>("SELECT source, waba_id, access_token_enc FROM whatsapp_channels WHERE agent_id = $1", [agent.id]);
  // Stop Meta sending this number's messages to us (best effort; the row is removed either way).
  if (ch?.source === "embedded" && ch.waba_id) await unsubscribeApp(ch.waba_id, decryptSecret(ch.access_token_enc)).catch(() => {});
  await q("DELETE FROM whatsapp_channels WHERE agent_id = $1", [agent.id]);
  return NextResponse.json({ ok: true });
});
