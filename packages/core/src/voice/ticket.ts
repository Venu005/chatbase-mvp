import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed tickets that let a browser open a voice session on the voice gateway: the customer app issues
 * one (after checking the agent has voice turned on), the gateway checks it. Signed with AUTH_SECRET.
 */
const secret = () => {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET must be set (32+ characters)");
  return s;
};
const sign = (body: string) => createHmac("sha256", secret()).update(`voice:${body}`).digest("base64url");

export function voiceTicket(agentId: string, sessionId: string, ttlSeconds = 120): string {
  const body = Buffer.from(JSON.stringify({ a: agentId, s: sessionId, e: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function checkVoiceTicket(ticket: string): { agentId: string; sessionId: string } | null {
  const [body, sig] = ticket.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { a, s, e } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof a !== "string" || typeof s !== "string" || typeof e !== "number" || e < Date.now() / 1000) return null;
    return { agentId: a, sessionId: s };
  } catch {
    return null;
  }
}
