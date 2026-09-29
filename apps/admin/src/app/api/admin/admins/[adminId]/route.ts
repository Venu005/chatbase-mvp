import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@chatbase/core/db";
import { HttpError, handle } from "@chatbase/core/http";
import { envAdminEmails, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

/** Removes an admin; their sessions end at once. ADMIN_EMAILS admins are removed from the environment instead. */
type Ctx = { params: Promise<{ adminId: string }> };

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const me = await requireAdmin();
  const id = z.string().uuid().parse((await params).adminId);
  if (id === me.id) throw new HttpError(400, "You can't remove yourself");
  const target = await q1<{ email: string }>("SELECT email FROM admins WHERE id = $1", [id]);
  if (!target) throw new HttpError(404, "Not found");
  if (envAdminEmails().includes(target.email)) throw new HttpError(400, "This admin is listed in ADMIN_EMAILS; remove them there");
  await q1("DELETE FROM admins WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
});
