import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@/lib/db";
import { HttpError, clientIp, handle, rateLimit } from "@/lib/http";
import { normalizeEmail, normalizePhone, type LeadField } from "@/lib/leads";
import { upsertLead } from "@/lib/lead-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

const schema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  name: z.string().trim().max(100).optional(),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
});

/** The widget's lead form. Every field the owner asked for is required; others are ignored. */
export const POST = handle<Ctx>(async (req, { params }) => {
  const agentId = (await params).agentId;
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new HttpError(404, "Agent not found");
  const b = schema.parse(await req.json());
  if (!rateLimit(`lead:${clientIp(req)}:${agentId}`, 10, 60_000)) throw new HttpError(429, "Too many requests, please wait a moment.");

  const agent = await q1<{ lead_mode: string; lead_fields: LeadField[] }>("SELECT lead_mode, lead_fields FROM agents WHERE id = $1", [agentId]);
  if (!agent) throw new HttpError(404, "Agent not found");
  if (agent.lead_mode === "off") throw new HttpError(403, "This assistant doesn't collect contact details.");

  const want = new Set(agent.lead_fields);
  const lead: { name?: string; email?: string; phone?: string } = {};
  if (want.has("name")) {
    if (!b.name) throw new HttpError(400, "Please enter your name");
    lead.name = b.name;
  }
  if (want.has("email")) {
    const email = normalizeEmail(b.email ?? "");
    if (!email) throw new HttpError(400, "Please enter a valid e-mail address");
    lead.email = email;
  }
  if (want.has("phone")) {
    const phone = normalizePhone(b.phone ?? "");
    if (!phone) throw new HttpError(400, "Please enter a valid phone number");
    lead.phone = phone;
  }
  await upsertLead(agentId, b.sessionId, "widget", "form", lead);
  return NextResponse.json({ ok: true });
});
