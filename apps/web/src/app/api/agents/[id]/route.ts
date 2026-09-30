import { NextResponse } from "next/server";
import { z } from "zod";
import { q } from "@chatbase/core/db";
import { requireUser } from "@chatbase/core/auth";
import { handle } from "@chatbase/core/http";
import { ownAgent } from "@chatbase/core/agents";
import { MAX_ALLOWED_DOMAINS, normalizeDomain } from "@chatbase/core/domains";
import { LEAD_FIELDS } from "@chatbase/core/leads";
import { env } from "@chatbase/core/env";
import { VOICE_LANGUAGES, VOICE_SPEAKERS } from "@chatbase/core/voice/options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  // Phone setup: the addresses to paste into Plivo / Exotel (they carry the agent's secret voice token).
  const pub = env("VOICE_PUBLIC_URL")?.replace(/\/$/, "");
  const voice = pub
    ? {
        gateway: pub,
        plivoAnswerUrl: `${pub}/plivo/${agent.id}/answer?token=${agent.voice_token}`,
        exotelStreamUrl: `${pub.replace(/^http/, "ws")}/exotel/${agent.id}?token=${agent.voice_token}`,
      }
    : null;
  return NextResponse.json({ agent, voice });
});

const patch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().max(4000).optional(),
  welcomeMessage: z.string().trim().min(1).max(300).optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour must look like #4f46e5").optional(),
  handoffEnabled: z.boolean().optional(),
  handoffMessage: z.string().trim().min(1).max(300).optional(),
  notifyEmail: z.boolean().optional(),
  allowedDomains: z
    .array(z.string().max(300))
    .max(MAX_ALLOWED_DOMAINS, `Add up to ${MAX_ALLOWED_DOMAINS} websites`)
    .transform((list, ctx) => {
      const out = new Set<string>();
      for (const raw of list) {
        if (!raw.trim()) continue;
        const d = normalizeDomain(raw);
        if (d) out.add(d);
        else ctx.addIssue({ code: "custom", message: `“${raw.trim().slice(0, 60)}” isn't a website address` });
      }
      return [...out];
    })
    .optional(),
  leadMode: z.enum(["off", "after_first_answer", "before_chat"]).optional(),
  leadFields: z
    .array(z.enum(LEAD_FIELDS))
    .min(1, "Ask for at least one detail")
    .transform((f) => LEAD_FIELDS.filter((x) => f.includes(x)))
    .optional(),
  leadMessage: z.string().trim().min(1).max(300).optional(),
  voiceEnabled: z.boolean().optional(),
  voiceLanguage: z.enum(VOICE_LANGUAGES.map((l) => l.code) as [string, ...string[]]).optional(),
  voiceSpeaker: z.enum(VOICE_SPEAKERS.map((s) => s.id) as [string, ...string[]]).optional(),
  voiceGreeting: z.string().trim().max(300).optional(),
  voiceTransferNumber: z
    .string()
    .trim()
    .transform((s) => s.replace(/[\s()-]/g, ""))
    .refine((s) => s === "" || /^\+?\d{8,15}$/.test(s), "Enter a phone number with country code, like +919876543210")
    .transform((s) => (s ? (s.startsWith("+") ? s : `+${s}`) : null))
    .optional(),
  /** Makes new phone addresses; the old ones stop working. */
  resetVoiceToken: z.literal(true).optional(),
});

export const PATCH = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const b = patch.parse(await req.json());
  await q(
    `UPDATE agents SET name = $2, instructions = $3, welcome_message = $4, brand_color = $5,
            handoff_enabled = $6, handoff_message = $7, notify_email = $8, allowed_domains = $9,
            lead_mode = $10, lead_fields = $11, lead_message = $12,
            voice_enabled = $13, voice_language = $14, voice_speaker = $15, voice_greeting = $16, voice_transfer_number = $17,
            voice_token = CASE WHEN $18 THEN encode(gen_random_bytes(18), 'hex') ELSE voice_token END
      WHERE id = $1`,
    [
      agent.id,
      b.name ?? agent.name,
      b.instructions ?? agent.instructions,
      b.welcomeMessage ?? agent.welcome_message,
      b.brandColor ?? agent.brand_color,
      b.handoffEnabled ?? agent.handoff_enabled,
      b.handoffMessage ?? agent.handoff_message,
      b.notifyEmail ?? agent.notify_email,
      b.allowedDomains ?? agent.allowed_domains,
      b.leadMode ?? agent.lead_mode,
      b.leadFields ?? agent.lead_fields,
      b.leadMessage ?? agent.lead_message,
      b.voiceEnabled ?? agent.voice_enabled,
      b.voiceLanguage ?? agent.voice_language,
      b.voiceSpeaker ?? agent.voice_speaker,
      b.voiceGreeting ?? agent.voice_greeting,
      b.voiceTransferNumber === undefined ? agent.voice_transfer_number : b.voiceTransferNumber,
      b.resetVoiceToken ?? false,
    ]
  );
  return NextResponse.json({ ok: true });
});

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  await q("DELETE FROM agents WHERE id = $1", [agent.id]);
  return NextResponse.json({ ok: true });
});
