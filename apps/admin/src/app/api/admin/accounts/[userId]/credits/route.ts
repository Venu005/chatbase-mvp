import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { HttpError, handle } from "@chatbase/core/http";
import { audit } from "@/lib/admin";
import { grantCredits } from "@chatbase/core/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ userId: string }> };

const schema = z.object({
  credits: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, "Enter a number of credits"),
  reason: z.string().trim().min(3, "Say why (for the audit log)").max(300),
});

/** Adds (or, with a negative number, removes) bonus credits for this month. */
export const POST = handle<Ctx>(async (req, { params }) => {
  const me = await requireAdmin();
  const userId = (await params).userId;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(404, "Account not found");
  const { credits, reason } = schema.parse(await req.json());
  const user = await q1<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
  if (!user) throw new HttpError(404, "Account not found");
  const bonus = await grantCredits(userId, credits);
  await audit(me, "credits.grant", { id: userId, email: user.email }, { credits, bonus_this_month: bonus, reason });
  return NextResponse.json({ bonus });
});
