import { NextResponse } from "next/server";
import { z } from "zod";
import { q1 } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { HttpError, clientIp, handle, rateLimit } from "@/lib/http";
import { envNum } from "@/lib/env";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: z.string().trim().max(100).optional().default(""),
});

export const POST = handle(async (req) => {
  // Sign-ups per IP per hour (raise SIGNUP_RATE_LIMIT when running the test scripts repeatedly).
  const limit = envNum("SIGNUP_RATE_LIMIT", 10);
  if (!rateLimit(`signup:${clientIp(req)}`, limit, 60 * 60_000)) throw new HttpError(429, "Too many sign-ups, try again later");
  const { email, password, name } = schema.parse(await req.json());
  const hash = await hashPassword(password);
  const user = await q1<{ id: string }>(
    "INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id",
    [email, name, hash]
  );
  if (!user) throw new HttpError(409, "An account with this email already exists");
  await createSession(user.id);
  return NextResponse.json({ ok: true });
});
