import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getUsage } from "@/lib/usage";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await requireUser();
  return NextResponse.json({ user, usage: await getUsage(user.id, user.plan) });
});
