import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { planOf } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await requireUser();
  const agents = await q(
    `SELECT a.id, a.name, a.brand_color, a.created_at,
            (SELECT count(*)::int FROM sources s WHERE s.agent_id = a.id) AS source_count,
            (SELECT count(*)::int FROM conversations c WHERE c.agent_id = a.id) AS conversation_count,
            (SELECT count(*)::int FROM conversations c WHERE c.agent_id = a.id AND c.needs_reply) AS waiting_count
       FROM agents a WHERE a.user_id = $1 ORDER BY a.created_at DESC`,
    [user.id]
  );
  return NextResponse.json({ agents });
});

const schema = z.object({
  name: z.string().trim().min(1, "Give your agent a name").max(80),
  instructions: z.string().max(4000).optional().default(""),
});

export const POST = handle(async (req) => {
  const user = await requireUser();
  const { name, instructions } = schema.parse(await req.json());
  const plan = planOf(user.plan);
  const count = (await q1<{ n: number }>("SELECT count(*)::int AS n FROM agents WHERE user_id = $1", [user.id]))!.n;
  if (count >= plan.agents) throw new HttpError(402, `Your ${plan.name} plan allows ${plan.agents} agent(s). Upgrade to add more.`);
  const agent = await q1("INSERT INTO agents (user_id, name, instructions) VALUES ($1,$2,$3) RETURNING id, name", [user.id, name, instructions]);
  return NextResponse.json({ agent }, { status: 201 });
});
