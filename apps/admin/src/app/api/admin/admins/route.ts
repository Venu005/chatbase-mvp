import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@chatbase/core/db";
import { HttpError, handle } from "@chatbase/core/http";
import { envAdminEmails, hashPassword, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = { id: string; email: string; name: string; has_password: boolean; created_at: string; last_login_at: string | null; created_by: string | null };

/** Every admin: those who have signed in or were added here, plus ADMIN_EMAILS entries that haven't signed in yet. */
export const GET = handle(async () => {
  const me = await requireAdmin();
  const rows = await q<Row>(
    `SELECT a.id, a.email, a.name, a.password_hash IS NOT NULL AS has_password, a.created_at, a.last_login_at, c.email AS created_by
       FROM admins a LEFT JOIN admins c ON c.id = a.created_by
      ORDER BY a.created_at`
  );
  const env = envAdminEmails();
  const known = new Set(rows.map((r) => r.email));
  const admins = [
    ...rows.map((r) => ({ ...r, fromEnv: env.includes(r.email), you: r.id === me.id })),
    ...env.filter((e) => !known.has(e)).map((email) => ({ id: null, email, name: "", has_password: false, created_at: null, last_login_at: null, created_by: null, fromEnv: true, you: false })),
  ];
  return NextResponse.json({ admins });
});

const addSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(100).optional().default(""),
  password: z.string().min(12, "Use at least 12 characters").max(200),
});

/** Adds an admin with their own password. Share the password with them privately; they can change it after signing in. */
export const POST = handle(async (req) => {
  const me = await requireAdmin();
  const { email, name, password } = addSchema.parse(await req.json());
  const row = await q1<{ id: string }>(
    "INSERT INTO admins (email, name, password_hash, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id",
    [email, name, await hashPassword(password), me.id]
  );
  if (!row) throw new HttpError(409, "That e-mail is already an admin");
  await audit(me, "admin.add", null, { email });
  return NextResponse.json({ id: row.id, email, name }, { status: 201 });
});
