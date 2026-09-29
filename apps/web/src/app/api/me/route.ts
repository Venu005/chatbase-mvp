import { NextResponse } from "next/server";
import { requireUser } from "@chatbase/core/auth";
import { getUsage } from "@chatbase/core/usage";
import { handle } from "@chatbase/core/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await requireUser();
  return NextResponse.json({ user, usage: await getUsage(user.id, user.plan) });
});
