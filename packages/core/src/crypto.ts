import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encrypts secrets (WhatsApp tokens...) before they go into the database.
 * Key = HKDF(ENCRYPTION_KEY, or AUTH_SECRET if unset). Set a dedicated ENCRYPTION_KEY in production:
 * changing it (or AUTH_SECRET when no ENCRYPTION_KEY is set) makes existing encrypted values unreadable.
 */
function key(): Buffer {
  const base = process.env.ENCRYPTION_KEY?.trim() || process.env.AUTH_SECRET;
  if (!base || base.length < 32 || /replace[-_ ]?me|change[-_ ]?me/i.test(base) /* unfilled template value */) throw new Error("Set ENCRYPTION_KEY (or AUTH_SECRET) to a random string of 32+ characters, not the placeholder from .env.example");
  return Buffer.from(hkdfSync("sha256", base, "chatbase-india", "secrets-v1", 32));
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, data] = stored.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised encrypted value");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

export function hmacSha256Hex(secret: string, body: string | Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
