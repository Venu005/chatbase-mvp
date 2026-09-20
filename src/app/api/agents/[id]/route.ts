import { NextResponse } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";

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
});

export const PATCH = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const b = patch.parse(await req.json());
  await q(
    `UPDATE agents SET name = $2, instructions = $3, welcome_message = $4, brand_color = $5,
            handoff_enabled = $6, handoff_message = $7, notify_email = $8 WHERE id = $1`,
    [
      agent.id,
      b.name ?? agent.name,
      b.instructions ?? agent.instructions,
      b.welcomeMessage ?? agent.welcome_message,
      b.brandColor ?? agent.brand_color,
      b.handoffEnabled ?? agent.handoff_enabled,
      b.handoffMessage ?? agent.handoff_message,
      b.notifyEmail ?? agent.notify_email,
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
