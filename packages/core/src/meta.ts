import { graph, graphError } from "./whatsapp";
import { HttpError } from "./http";
import { env, envStr } from "./env";

/**
 * Platform-level Meta (Facebook) app used for WhatsApp Embedded Signup. One app serves all your customers.
 * See docs/embedded-signup.md for how to create it and where each value comes from.
 */
export type MetaApp = { appId: string; appSecret: string; configId: string; graphVersion: string };

export function metaApp(): MetaApp | null {
  const appId = env("META_APP_ID");
  const appSecret = env("META_APP_SECRET");
  const configId = env("META_ES_CONFIG_ID");
  if (!appId || !appSecret || !configId) return null;
  return { appId, appSecret, configId, graphVersion: envStr("WHATSAPP_GRAPH_VERSION", "v25.0") };
}

/** Public values the browser needs to open the signup popup (never the secret). */
export function embeddedSignupPublic() {
  const m = metaApp();
  return m ? { available: true, appId: m.appId, configId: m.configId, graphVersion: m.graphVersion } : { available: false };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const timeout = () => AbortSignal.timeout(15_000);

/** Trades the one-time code from the popup (valid ~30 seconds) for the customer's business token. */
export async function exchangeCode(code: string): Promise<string> {
  const m = metaApp();
  if (!m) throw new HttpError(503, "WhatsApp signup isn't configured on this server");
  const url = `${graph()}/oauth/access_token?${new URLSearchParams({ client_id: m.appId, client_secret: m.appSecret, code })}`;
  const res = await fetch(url, { signal: timeout() });
  if (!res.ok) throw new HttpError(400, `Meta rejected the signup code (it expires after about 30 seconds): ${await graphError(res)}`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new HttpError(400, "Meta did not return an access token");
  return j.access_token;
}

/** Confirms the WhatsApp Business Account really contains this phone number (client-supplied ids are untrusted). */
export async function wabaHasPhone(wabaId: string, phoneNumberId: string, token: string): Promise<boolean> {
  const res = await fetch(`${graph()}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=100`, { headers: auth(token), signal: timeout() });
  if (!res.ok) throw new HttpError(400, `Couldn't read the WhatsApp account: ${await graphError(res)}`);
  const j = (await res.json()) as { data?: { id: string }[] };
  return !!j.data?.some((p) => p.id === phoneNumberId);
}

/** Makes Meta deliver this WABA's messages to our app-level webhook. Without it the number never receives anything. */
export async function subscribeApp(wabaId: string, token: string): Promise<void> {
  const res = await fetch(`${graph()}/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "POST", headers: auth(token), signal: timeout() });
  if (!res.ok) throw new HttpError(502, `Couldn't subscribe to this WhatsApp account's messages: ${await graphError(res)}`);
}

export async function unsubscribeApp(wabaId: string, token: string): Promise<void> {
  await fetch(`${graph()}/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "DELETE", headers: auth(token), signal: timeout() }).catch(() => {});
}

/** Registers the number for the Cloud API. Returns an error message instead of throwing: it may already be registered. */
export async function registerPhone(phoneNumberId: string, token: string, pin: string): Promise<string | null> {
  const res = await fetch(`${graph()}/${encodeURIComponent(phoneNumberId)}/register`, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    signal: timeout(),
  });
  return res.ok ? null : await graphError(res);
}
