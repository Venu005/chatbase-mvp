import { NextResponse } from "next/server";
import { handle } from "@chatbase/core/http";
import { destroyAdminSession } from "@/lib/auth";

export const POST = handle(async () => {
  await destroyAdminSession();
  return NextResponse.json({ ok: true });
});
