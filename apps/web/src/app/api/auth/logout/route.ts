import { NextResponse } from "next/server";
import { destroySession } from "@chatbase/core/auth";
import { handle } from "@chatbase/core/http";

export const runtime = "nodejs";

export const POST = handle(async () => {
  await destroySession();
  return NextResponse.json({ ok: true });
});
