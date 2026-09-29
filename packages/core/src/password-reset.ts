import { createHash } from "node:crypto";
import { q, q1 } from "./db";
import { randomToken } from "./crypto";
import { sendEmail } from "./notify";
import { envStr } from "./env";

const TTL_MINUTES = 60;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * E-mails a single-use reset link if the account exists. Callers must answer the same way either way,
 * so nobody can find out which e-mails have accounts. Only the token's hash is stored.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await q1<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = $1", [email]);
  if (!user) return;
  // At most 3 links per account per hour, so the form can't be used to flood someone's inbox.
  const recent = (await q1<{ n: number }>("SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'", [user.id]))!.n;
  if (recent >= 3) return;

  const token = randomToken(32);
  await q("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' minutes')::interval)", [
    hashToken(token),
    user.id,
    String(TTL_MINUTES),
  ]);
  const link = `${envStr("APP_URL", "http://localhost:3000").replace(/\/$/, "")}/reset-password?token=${token}`;
  const sent = await sendEmail(
    user.email,
    "Reset your password",
    [
      "Someone (hopefully you) asked to reset the password for this account.",
      "",
      `Choose a new password here (the link works once, for ${TTL_MINUTES} minutes):`,
      link,
      "",
      "If you didn't ask for this, ignore this e-mail: your password stays the same.",
    ].join("\n")
  );
  // Local development without SMTP: print the link so the flow can still be tested. Never in production.
  if (!sent && process.env.NODE_ENV !== "production") console.warn(`Password reset link for ${user.email} (SMTP not configured): ${link}`);
}

/** Uses a reset token: returns the user id and new session version, or null if the link is invalid/expired/used. */
export async function consumePasswordReset(token: string, passwordHash: string): Promise<{ userId: string; sessionVersion: number } | null> {
  const claimed = await q1<{ user_id: string }>(
    "UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id",
    [hashToken(token)]
  );
  if (!claimed) return null;
  const user = await q1<{ session_version: number }>(
    "UPDATE users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING session_version",
    [claimed.user_id, passwordHash]
  );
  // Any other outstanding links for this account are now pointless; retire them.
  await q("UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [claimed.user_id]);
  return user && { userId: claimed.user_id, sessionVersion: user.session_version };
}
