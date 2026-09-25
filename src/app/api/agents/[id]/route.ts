import { NextResponse } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";
import { MAX_ALLOWED_DOMAINS, normalizeDomain } from "@/lib/domains";
import { LEAD_FIELDS } from "@/lib/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  return NextResponse.json({ agent });
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
});

export const PATCH = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const b = patch.parse(await req.json());
  await q(
    `UPDATE agents SET name = $2, instructions = $3, welcome_message = $4, brand_color = $5,
            handoff_enabled = $6, handoff_message = $7, notify_email = $8, allowed_domains = $9,
            lead_mode = $10, lead_fields = $11, lead_message = $12 WHERE id = $1`,
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
