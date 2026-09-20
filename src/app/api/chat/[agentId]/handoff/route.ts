import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { HttpError, clientIp, handle, rateLimit } from "@/lib/http";
import { loadAgent } from "@/lib/answer";
import { findConversation, startHandoff } from "@/lib/handoff";
import { notifyOwner } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

const schema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  // Optional phone/e-mail so the business can reach the visitor if they close the chat.
  contact: z.string().trim().min(3, "Enter a phone number or e-mail").max(200).optional(),
});

/** The widget's "Talk to a human" button, and where the visitor leaves contact details. */
export const POST = handle<Ctx>(async (req, { params }) => {
  const agentId = (await params).agentId;
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new HttpError(404, "Agent not found");
  const { sessionId, contact } = schema.parse(await req.json());
  if (!rateLimit(`handoff:${clientIp(req)}:${agentId}`, 10, 60_000)) throw new HttpError(429, "Too many requests, please wait a moment.");

  const agent = await loadAgent(agentId);
  if (!agent) throw new HttpError(404, "Agent not found");

  let existing = await findConversation(agentId, sessionId);
  let notice: string | null = null;
  if (existing?.mode !== "human") {
    if (!agent.handoff_enabled) throw new HttpError(403, "Talking to a person isn't available for this assistant.");
    const r = await startHandoff(agent, { sessionId, channel: "widget", reason: "Visitor pressed “Talk to a human”" });
    existing = { id: r.conversationId, mode: "human", channel: "widget" };
    notice = r.notice;
  }
  if (contact) {
    const prior = await q1<{ visitor_contact: string | null }>("SELECT visitor_contact FROM conversations WHERE id = $1", [existing.id]);
    await q("UPDATE conversations SET visitor_contact = $2 WHERE id = $1", [existing.id, contact]);
    if (!prior?.visitor_contact) void notifyOwner(existing.id, { force: true, kind: "contact" }); // only the first time: no mail floods
  }
  return NextResponse.json({ mode: "human", notice, conversationId: existing.id });
});
