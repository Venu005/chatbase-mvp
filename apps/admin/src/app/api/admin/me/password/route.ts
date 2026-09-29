import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@chatbase/core/db";
import { HttpError, clientIp, handle, rateLimit } from "@chatbase/core/http";
import { checkCredentials, createAdminSession, hashPassword, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12, "Use at least 12 characters").max(200),
});

/** Changes the signed-in admin's own password. Other sessions of this admin end; this one is renewed. */
export const POST = handle(async (req) => {
  if (!rateLimit(`admin-password:${clientIp(req)}`, 10, 15 * 60_000)) throw new HttpError(429, "Too many attempts, try again in a few minutes");
  const me = await requireAdmin();
  const { currentPassword, newPassword } = schema.parse(await req.json());
  if (!(await checkCredentials(me.email, currentPassword))) throw new HttpError(400, "Your current password is incorrect");
  const row = await q1<{ session_version: number }>(
    "UPDATE admins SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING session_version",
    [me.id, await hashPassword(newPassword)]
  );
  await createAdminSession(me.id, row!.session_version);
  return NextResponse.json({ ok: true });
});
