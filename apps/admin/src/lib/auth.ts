import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { q1 } from "@chatbase/core/db";
import { hashPassword, verifyPassword } from "@chatbase/core/auth";
import { safeEqual } from "@chatbase/core/crypto";
import { env, isPlaceholder } from "@chatbase/core/env";
import { HttpError } from "@chatbase/core/http";

// Admin sessions are separate from customer sessions: their own cookie, and tokens carry an audience that customer
// tokens don't, so neither kind of token works in the other app.
const COOKIE = "cb_admin";
const AUDIENCE = "chatbase-admin";
const MAX_AGE = 60 * 60 * 12;

export type Admin = { id: string; email: string; name: string; fromEnv: boolean };
type AdminRow = { id: string; email: string; name: string; password_hash: string | null; session_version: number };

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32 || isPlaceholder(s)) throw new Error("AUTH_SECRET must be set to a random string of 32+ characters (openssl rand -base64 48)");
  return new TextEncoder().encode(s);
}

/** E-mails in ADMIN_EMAILS (comma-separated, lower-cased). */
export function envAdminEmails(): string[] {
  return (env("ADMIN_EMAILS") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** ADMIN_PASSWORD, when it is set to something usable (12+ characters, not a template placeholder). */
function envAdminPassword(): string | null {
  const pw = env("ADMIN_PASSWORD");
  return pw && pw.length >= 12 && !isPlaceholder(pw) ? pw : null;
}

/** An ADMIN_EMAILS admin can sign in with ADMIN_PASSWORD while both are set. */
const envAdminActive = (email: string) => envAdminPassword() !== null && envAdminEmails().includes(email.toLowerCase());

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword("not-a-real-password"));

/** Checks e-mail and password; returns the admin row (created on first sign-in for ADMIN_EMAILS admins) or null. */
export async function checkCredentials(email: string, password: string): Promise<AdminRow | null> {
  email = email.trim().toLowerCase();
  const envPw = envAdminPassword();
  if (envPw && envAdminEmails().includes(email) && safeEqual(password, envPw)) {
    return (await q1<AdminRow>(
      `INSERT INTO admins (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email, name, password_hash, session_version`,
      [email]
    ))!;
  }
  const row = await q1<AdminRow>("SELECT id, email, name, password_hash, session_version FROM admins WHERE email = $1", [email]);
  // Run bcrypt even for unknown e-mails, so the response time doesn't tell which admins exist.
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
  return row?.password_hash && ok ? row : null;
}

export async function createAdminSession(adminId: string, sessionVersion: number) {
  const token = await new SignJWT({ sv: sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(adminId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: (env("ADMIN_URL") ?? env("APP_URL") ?? "").startsWith("https://"),
    path: "/",
    maxAge: MAX_AGE,
  });
  await q1("UPDATE admins SET last_login_at = now() WHERE id = $1", [adminId]);
}

export async function destroyAdminSession() {
  (await cookies()).delete(COOKIE);
}

export async function getAdmin(): Promise<Admin | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"], audience: AUDIENCE });
    if (!payload.sub) return null;
    const row = await q1<AdminRow>("SELECT id, email, name, password_hash, session_version FROM admins WHERE id = $1", [payload.sub]);
    if (!row || payload.sv !== row.session_version) return null;
    const fromEnv = envAdminEmails().includes(row.email);
    // An ADMIN_EMAILS admin without an own password loses access once removed from ADMIN_EMAILS (or ADMIN_PASSWORD is unset).
    if (!row.password_hash && !envAdminActive(row.email)) return null;
    return { id: row.id, email: row.email, name: row.name, fromEnv };
  } catch {
    return null;
  }
}

/** For admin API routes. */
export async function requireAdmin(): Promise<Admin> {
  const admin = await getAdmin();
  if (!admin) throw new HttpError(401, "Please sign in");
  return admin;
}

export { hashPassword, verifyPassword };
