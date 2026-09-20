import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { encryptSecret, randomToken } from "@/lib/crypto";
import { HttpError, handle, rateLimit } from "@/lib/http";
import { ownAgent } from "@/lib/agents";
import { exchangeCode, metaApp, registerPhone, subscribeApp, wabaHasPhone } from "@/lib/meta";
import { fetchPhoneInfo } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  code: z.string().trim().min(5).max(2000),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/),
  wabaId: z.string().trim().regex(/^\d{5,30}$/),
  businessId: z.string().trim().regex(/^\d{1,30}$/).optional(),
});

/**
 * Finishes WhatsApp Embedded Signup. The browser sends what the Meta popup returned; we trust none of it
 * until the customer's own token proves it: the code is exchanged server-side (with our app secret), and the
 * resulting token must be able to read both the number and its WhatsApp Business Account.
 */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  if (!metaApp()) throw new HttpError(503, "WhatsApp signup isn't configured on this server. Ask the administrator to set META_APP_ID, META_APP_SECRET and META_ES_CONFIG_ID.");
  if (!rateLimit(`wa-es:${user.id}`, 10, 10 * 60_000)) throw new HttpError(429, "Too many attempts, please wait a few minutes.");
  const b = schema.parse(await req.json());

  const token = await exchangeCode(b.code);
  const info = await fetchPhoneInfo(b.phoneNumberId, token);
  if (!(await wabaHasPhone(b.wabaId, b.phoneNumberId, token))) throw new HttpError(400, "That phone number does not belong to the WhatsApp account Meta reported. Please try again.");
  const other = await q1("SELECT 1 FROM whatsapp_channels WHERE phone_number_id = $1 AND agent_id <> $2", [b.phoneNumberId, agent.id]);
  if (other) throw new HttpError(409, "This WhatsApp number is already connected to another agent");

  await subscribeApp(b.wabaId, token); // hard requirement: without it Meta never sends us this number's messages
  const pin = String(randomInt(0, 1_000_000)).padStart(6, "0"); // two-step verification PIN for the number (kept encrypted)
  const registerError = await registerPhone(b.phoneNumberId, token, pin);

  await q1(
    `INSERT INTO whatsapp_channels (agent_id, phone_number_id, display_phone_number, verified_name, access_token_enc, app_secret_enc, verify_token,
                                    source, waba_id, business_id, registration_pin_enc)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,'embedded',$7,$8,$9)
     ON CONFLICT (agent_id) DO UPDATE SET phone_number_id = EXCLUDED.phone_number_id, display_phone_number = EXCLUDED.display_phone_number,
       verified_name = EXCLUDED.verified_name, access_token_enc = EXCLUDED.access_token_enc, app_secret_enc = NULL, source = 'embedded',
       waba_id = EXCLUDED.waba_id, business_id = EXCLUDED.business_id, registration_pin_enc = EXCLUDED.registration_pin_enc
     RETURNING id`,
    [agent.id, b.phoneNumberId, info.display_phone_number, info.verified_name, encryptSecret(token), randomToken(), b.wabaId, b.businessId ?? null, encryptSecret(pin)]
  );
  return NextResponse.json({
    connected: true,
    displayPhoneNumber: info.display_phone_number,
    verifiedName: info.verified_name,
    // Not fatal (the number may already have been registered), but worth showing to the owner.
    warning: registerError ? `Connected, but WhatsApp did not confirm the number's registration: ${registerError}` : undefined,
  });
});
