import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, clientIp, handle, rateLimit } from "@/lib/http";
import { requestPasswordReset } from "@/lib/password-reset";

export const runtime = "nodejs";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(200) });

/** Always answers the same way, whether or not the e-mail has an account (no account enumeration). */
export const POST = handle(async (req) => {
  if (!rateLimit(`forgot:${clientIp(req)}`, 5, 15 * 60_000)) throw new HttpError(429, "Too many attempts, try again in a few minutes");
  const { email } = schema.parse(await req.json());
  await requestPasswordReset(email);
  return NextResponse.json({ ok: true });
});
