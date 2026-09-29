import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, clientIp, handle, rateLimit } from "@chatbase/core/http";
import { checkCredentials, createAdminSession } from "@/lib/auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export const POST = handle(async (req) => {
  if (!rateLimit(`admin-login:${clientIp(req)}`, 10, 15 * 60_000)) throw new HttpError(429, "Too many attempts, try again in a few minutes");
  const { email, password } = schema.parse(await req.json());
  const admin = await checkCredentials(email, password);
  // Same error for unknown e-mail and wrong password.
  if (!admin) throw new HttpError(401, "Incorrect email or password");
  await createAdminSession(admin.id, admin.session_version);
  return NextResponse.json({ ok: true });
});
