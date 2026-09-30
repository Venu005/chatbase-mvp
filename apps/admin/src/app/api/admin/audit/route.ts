import { NextResponse } from "next/server";
import { q } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@chatbase/core/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The newest 200 admin actions (or those about one account, with ?userId=). */
export const GET = handle(async (req) => {
  await requireAdmin();
  const userId = req.nextUrl.searchParams.get("userId");
  const valid = userId && /^[0-9a-f-]{36}$/i.test(userId);
  const entries = await q(
    `SELECT id, admin_email, action, target_user_id, target_email, details, created_at FROM admin_audit
      ${valid ? "WHERE target_user_id = $1" : ""} ORDER BY created_at DESC LIMIT 200`,
    valid ? [userId] : []
  );
  return NextResponse.json({ entries });
});
