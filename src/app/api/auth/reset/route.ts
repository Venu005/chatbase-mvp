import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, hashPassword } from "@/lib/auth";
import { HttpError, clientIp, handle, rateLimit } from "@/lib/http";
import { consumePasswordReset } from "@/lib/password-reset";

export const runtime = "nodejs";

const schema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, "This reset link is invalid"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

/** Sets the new password, signs out every other session, and signs this browser in. */
export const POST = handle(async (req) => {
  if (!rateLimit(`reset:${clientIp(req)}`, 10, 15 * 60_000)) throw new HttpError(429, "Too many attempts, try again in a few minutes");
  const { token, password } = schema.parse(await req.json());
  const r = await consumePasswordReset(token, await hashPassword(password));
  if (!r) throw new HttpError(400, "This reset link has expired or was already used. Ask for a new one.");
  await createSession(r.userId, r.sessionVersion);
  return NextResponse.json({ ok: true });
});
