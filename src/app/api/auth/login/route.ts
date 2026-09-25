import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@/lib/db";
import { createSession, verifyPassword } from "@/lib/auth";
import { HttpError, clientIp, handle, rateLimit } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export const POST = handle(async (req) => {
  if (!rateLimit(`login:${clientIp(req)}`, 10, 5 * 60_000)) throw new HttpError(429, "Too many attempts, try again in a few minutes");
  const { email, password } = schema.parse(await req.json());
  const user = await q1<{ id: string; password_hash: string; session_version: number }>("SELECT id, password_hash, session_version FROM users WHERE email = $1", [email]);
  // Same error for unknown email and wrong password (no account enumeration).
  if (!user || !(await verifyPassword(password, user.password_hash))) throw new HttpError(401, "Incorrect email or password");
  await createSession(user.id, user.session_version);
  return NextResponse.json({ ok: true });
});
