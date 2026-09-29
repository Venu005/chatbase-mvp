import { q } from "./db";
import { decryptSecret, hmacSha256Hex, safeEqual } from "./crypto";
import { answerOnce, loadAgent } from "./answer";
import { HttpError, rateLimit } from "./http";
import { formatForWhatsApp } from "./wa-format";
import { findConversation, recordVisitorMessage } from "./handoff";
import { env, envStr } from "./env";
import { upsertLead } from "./lead-store";
import { speechToTextConfigured, transcribe } from "./speech";

// ---------------------------------------------------------------------------
// WhatsApp Cloud API (Meta). Docs: send = POST {graph}/{version}/{phone_number_id}/messages,
// webhooks are signed with X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, app secret).
// ---------------------------------------------------------------------------

export const graph = () =>
  `${envStr("WHATSAPP_GRAPH_BASE_URL", "https://graph.facebook.com").replace(/\/$/, "")}/${envStr("WHATSAPP_GRAPH_VERSION", "v25.0")}`;

export type Channel = {
  id: string;
  agent_id: string;
  phone_number_id: string;
  display_phone_number: string;
  verified_name: string;
  access_token_enc: string;
  /** Null for channels connected through Embedded Signup: those use the platform's META_APP_SECRET. */
  app_secret_enc: string | null;
  verify_token: string;
  source: "manual" | "embedded";
  waba_id: string | null;
};

/** The secret Meta signs this channel's webhooks with. */
export function channelAppSecret(ch: Pick<Channel, "app_secret_enc">): string {
  if (ch.app_secret_enc) return decryptSecret(ch.app_secret_enc);
  const s = env("META_APP_SECRET");
  if (!s) throw new Error("META_APP_SECRET is not set");
  return s;
}

/**
 * Shared by both webhook routes: answers each inbound message in the background (after the HTTP 200 has
 * been sent), skipping message ids we have already seen (Meta delivers at-least-once).
 */
export function processInBackground(pairs: { channel: Channel; message: Incoming }[]): void {
  if (!pairs.length) return;
  void (async () => {
    for (const { channel, message } of pairs) {
      try {
        const fresh = await q("INSERT INTO whatsapp_events (wamid) VALUES ($1) ON CONFLICT DO NOTHING RETURNING wamid", [message.wamid]);
        if (!fresh.length) continue; // duplicate delivery
        await processIncoming(channel, message);
      } catch (e) {
        console.error("WhatsApp message processing failed:", e);
      }
    }
    if (Math.random() < 0.01) await q("DELETE FROM whatsapp_events WHERE received_at < now() - interval '7 days'").catch(() => {});
  })();
}

export async function graphError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Proves the token can access the phone number, and gets its display details. */
export async function fetchPhoneInfo(phoneNumberId: string, token: string): Promise<{ display_phone_number: string; verified_name: string }> {
  const res = await fetch(`${graph()}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpError(400, `WhatsApp rejected these credentials: ${await graphError(res)}`);
  const j = (await res.json()) as { display_phone_number?: string; verified_name?: string };
  return { display_phone_number: j.display_phone_number ?? "", verified_name: j.verified_name ?? "" };
}

export async function sendText(phoneNumberId: string, token: string, to: string, body: string): Promise<void> {
  const res = await fetch(`${graph()}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: true, body } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`WhatsApp send failed: ${await graphError(res)}`);
}

const MAX_MEDIA_BYTES = 16 * 1024 * 1024; // WhatsApp's own limit for audio

/** Downloads a customer's media (voice note): look up its short-lived URL, then fetch it with the same token. */
export async function downloadMedia(mediaId: string, token: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }> {
  const meta = await fetch(`${graph()}/${encodeURIComponent(mediaId)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!meta.ok) throw new Error(`WhatsApp media lookup failed: ${await graphError(meta)}`);
  const j = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!j.url) throw new Error("WhatsApp media has no URL");
  if ((j.file_size ?? 0) > MAX_MEDIA_BYTES) throw new Error("Voice note is too large");
  const res = await fetch(j.url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`WhatsApp media download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error("Voice note is too large");
  return { bytes, mimeType: j.mime_type ?? res.headers.get("content-type") ?? "audio/ogg" };
}

export function verifySignature(rawBody: Buffer, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7), hmacSha256Hex(appSecret, rawBody));
}

// ---- inbound payload ---------------------------------------------------------
export type Incoming = { phoneNumberId: string; from: string; wamid: string; type: string; text: string; name?: string; mediaId?: string };

/** Pulls user messages out of a webhook payload. Status updates and unknown shapes yield nothing. */
export function extractIncoming(payload: unknown): Incoming[] {
  const out: Incoming[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  if (p?.object !== "whatsapp_business_account" || !Array.isArray(p.entry)) return out;
  for (const entry of p.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const v = change.value;
      const phoneNumberId = v?.metadata?.phone_number_id;
      if (typeof phoneNumberId !== "string") continue;
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) if (typeof c?.wa_id === "string" && typeof c?.profile?.name === "string") names.set(c.wa_id, c.profile.name.slice(0, 100));
      for (const m of v.messages ?? []) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string") continue;
        out.push({
          phoneNumberId,
          from: m.from,
          wamid: m.id,
          type: String(m.type ?? "unknown"),
          text: m.type === "text" ? String(m.text?.body ?? "") : "",
          name: names.get(m.from),
          ...(m.type === "audio" && typeof m.audio?.id === "string" ? { mediaId: m.audio.id } : {}),
        });
      }
    }
  }
  return out;
}

// ---- processing -------------------------------------------------------------------
/** Answers one inbound WhatsApp message through the same pipeline as the website widget. */
export async function processIncoming(ch: Channel, m: Incoming): Promise<void> {
  const token = decryptSecret(ch.access_token_enc);
  const reply = async (text: string) => {
    for (const part of formatForWhatsApp(text, [])) await sendText(ch.phone_number_id, token, m.from, part);
  };

  const session = `wa_${m.from}`;
  if (!rateLimit(`wa:${ch.id}:${m.from}`, 10, 60_000)) return; // silently ignore floods
  // Every WhatsApp customer is a lead: their number (and WhatsApp profile name) go to the Leads tab.
  await upsertLead(ch.agent_id, session, "whatsapp", "whatsapp", { phone: `+${m.from}`, name: m.name }).catch((e) => console.error("Saving lead failed:", e));
  // Voice notes: transcribe them and carry on as if the customer had typed the words (marked with 🎤).
  let text = m.type === "text" ? m.text : "";
  let voiceFailed = false;
  if (m.type === "audio" && m.mediaId && speechToTextConfigured()) {
    try {
      const media = await downloadMedia(m.mediaId, token);
      const t = await transcribe(media.bytes, media.mimeType);
      if (t.text) text = `🎤 ${t.text}`;
      else voiceFailed = true;
    } catch (e) {
      console.error("Voice note transcription failed:", (e as Error).message);
      voiceFailed = true;
    }
  }

  if (!text.trim()) {
    // If a person is handling this chat, an image/voice note is exactly what they need to know about.
    const convo = await findConversation(ch.agent_id, session);
    if (convo?.mode === "human") {
      await recordVisitorMessage(convo.id, `[The customer sent a ${m.type} message. Media isn't shown here - open WhatsApp on your phone to view it.]`);
      return;
    }
    await reply(
      voiceFailed
        ? "Sorry, I couldn't make out that voice note. Please type your question, or send a shorter voice message (under 30 seconds)."
        : speechToTextConfigured()
          ? "Sorry, I can only read text and voice messages for now. Please type your question."
          : "Sorry, I can only read text messages for now. Please type your question."
    );
    return;
  }

  const agent = await loadAgent(ch.agent_id);
  if (!agent) return;
  await q("UPDATE whatsapp_channels SET last_message_at = now() WHERE id = $1", [ch.id]);

  let parts: string[];
  try {
    const r = await answerOnce(agent, session, "whatsapp", text.slice(0, 2000));
    if ("handedOff" in r) {
      // A person owns this chat: send the "team will reply" notice once (when it starts), then stay silent.
      parts = r.notice ? [r.notice] : [];
    } else {
      parts = formatForWhatsApp(r.text, r.citations);
    }
  } catch (e) {
    if (!(e instanceof HttpError)) console.error("WhatsApp answer failed:", e);
    parts = [e instanceof HttpError ? e.message : "Sorry, I couldn't answer that right now. Please try again in a moment."];
  }
  for (const part of parts) await sendText(ch.phone_number_id, token, m.from, part);
}
