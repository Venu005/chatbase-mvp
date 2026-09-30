import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@chatbase/core/db";
import { HttpError, clientIp, handle, rateLimit } from "@chatbase/core/http";
import { env } from "@chatbase/core/env";
import { voiceTicket } from "@chatbase/core/voice/ticket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

const schema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });

/**
 * Starts website voice mode: returns the voice gateway's WebSocket address with a 2-minute signed ticket for this
 * agent and visitor session. Only for agents with voice turned on, when a gateway is configured (VOICE_PUBLIC_URL).
 */
export const POST = handle<Ctx>(async (req, { params }) => {
  const agentId = (await params).agentId;
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new HttpError(404, "Agent not found");
  const { sessionId } = schema.parse(await req.json());
  if (!rateLimit(`voice:${clientIp(req)}`, 10, 60_000)) throw new HttpError(429, "Too many voice sessions. Please wait a moment.");
  const pub = env("VOICE_PUBLIC_URL");
  const agent = await q1<{ voice_enabled: boolean }>("SELECT voice_enabled FROM agents WHERE id = $1", [agentId]);
  if (!agent) throw new HttpError(404, "Agent not found");
  if (!agent.voice_enabled || !pub) throw new HttpError(403, "Voice isn't available for this assistant");
  const ticket = voiceTicket(agentId, sessionId);
  return NextResponse.json({ url: `${pub.replace(/\/$/, "").replace(/^http/, "ws")}/web?ticket=${encodeURIComponent(ticket)}` });
});
