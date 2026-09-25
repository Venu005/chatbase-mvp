// End-to-end test of the WhatsApp channel against a RUNNING server, using a local FAKE Meta Graph API.
// Start the app pointing at the fake (which also fakes Sarvam speech-to-text for voice notes), then run this script:
//   WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4020 SARVAM_API_KEY=sarvam-test-key SARVAM_STT_URL=http://127.0.0.1:4020/speech-to-text pnpm start
//   pnpm smoke:whatsapp
// Set DATABASE_URL (pnpm loads .env for you via --env-file-if-exists) to also check secrets are encrypted at rest.
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const GRAPH_PORT = Number(process.env.FAKE_GRAPH_PORT ?? 4020);
const TOKEN = "good-token-" + "x".repeat(30);
const APP_SECRET = "meta-app-secret-for-tests";
const RUN = Date.now().toString(36); // message ids must be unique per run: duplicates are (correctly) ignored
const PHONE_ID = `1098${Date.now()}`; // unique per run so the test can be repeated against the same database
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake Meta Graph API ------------------------------------------------------
const sent = [];
const transcribed = [];
const graph = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    // Fake Sarvam speech-to-text (multipart upload of the voice note).
    if (req.method === "POST" && req.url === "/speech-to-text") {
      if (req.headers["api-subscription-key"] !== "sarvam-test-key") return (res.statusCode = 403), res.end("{}");
      transcribed.push(body);
      if (body.includes("TOO-LONG-AUDIO")) return (res.statusCode = 400), res.end(JSON.stringify({ error: { message: "Audio longer than 30 seconds" } }));
      return res.end(JSON.stringify({ request_id: "r1", transcript: "दुकान कब खुलती है? When is the shop open?", language_code: "hi-IN" }));
    }
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    if (!authed) return (res.statusCode = 401), res.end(JSON.stringify({ error: { message: "Invalid OAuth access token." } }));
    // Voice notes: media lookup, then download from the (fake) CDN URL with the same token.
    const media = req.url.match(/^\/v[\d.]+\/(media-[\w-]+)$/);
    if (media) return res.end(JSON.stringify({ url: `http://127.0.0.1:${GRAPH_PORT}/cdn/${media[1]}`, mime_type: "audio/ogg; codecs=opus", file_size: 1200, id: media[1] }));
    const cdn = req.url.match(/^\/cdn\/media-([\w-]+)$/);
    if (cdn) return res.setHeader("content-type", "audio/ogg"), res.end(`OggS-fake-opus-${cdn[1]}`);
    const m = req.url.match(/^\/v[\d.]+\/(\d+)(\/messages)?(\?.*)?$/);
    if (!m) return (res.statusCode = 404), res.end("{}");
    if (req.method === "GET" && !m[2]) return res.end(JSON.stringify({ id: m[1], display_phone_number: "+91 98765 43210", verified_name: "Sharma Kirana" }));
    if (req.method === "POST" && m[2]) {
      const j = JSON.parse(body);
      sent.push({ phoneId: m[1], auth: req.headers.authorization, ...j });
      return res.end(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: j.to, wa_id: j.to }], messages: [{ id: `wamid.${RUN}.OUT` + sent.length }] }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => graph.listen(GRAPH_PORT, "127.0.0.1", r));

// ---- helpers ------------------------------------------------------------------------
function client() {
  let cookie = "";
  return {
    async json(path, { method = "GET", body } = {}) {
      const res = await fetch(BASE + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return { status: res.status, data: await res.json().catch(() => ({})), raw: res };
    },
  };
}

const payload = (wamid, from, msg, phoneId = PHONE_ID) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "919876543210", phone_number_id: phoneId }, contacts: [{ profile: { name: "Ravi" }, wa_id: from }], messages: [{ from, id: wamid, timestamp: "1700000000", ...msg }] } }] }],
});
const text = (body) => ({ type: "text", text: { body } });

async function deliver(url, obj, { secret = APP_SECRET, sign = true } = {}) {
  const raw = JSON.stringify(obj);
  const headers = { "content-type": "application/json" };
  if (sign) headers["x-hub-signature-256"] = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return fetch(url, { method: "POST", headers, body: raw });
}

async function waitForReplies(to, count, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const mine = sent.filter((s) => s.to === to);
    if (mine.length >= count) return mine;
    await sleep(100);
  }
  return sent.filter((s) => s.to === to);
}

try {
  console.log(`WhatsApp smoke test against ${BASE} (fake Graph API on :${GRAPH_PORT})`);
  const a = client();
  const email = `wa${Date.now()}@example.com`;
  await a.json("/api/auth/signup", { method: "POST", body: { email, password: "correct-horse-battery" } });
  const agentId = (await a.json("/api/agents", { method: "POST", body: { name: "Kirana Bot" } })).data.agent.id;
  await a.json(`/api/agents/${agentId}/sources`, {
    method: "POST",
    body: { type: "text", title: "Store info", text: "Our shop Sharma Kirana is open from 8am to 10pm every day. We offer free home delivery within 3 km for orders above 300 rupees." },
  });
  for (let i = 0; i < 40; i++) {
    if ((await a.json(`/api/agents/${agentId}/sources`)).data.sources.every((s) => s.status === "ready")) break;
    await sleep(250);
  }

  // ---- connecting -------------------------------------------------------------------
  assert.equal((await a.json(`/api/agents/${agentId}/whatsapp`)).data.connected, false);
  const badConnect = await a.json(`/api/agents/${agentId}/whatsapp`, { method: "PUT", body: { phoneNumberId: PHONE_ID, accessToken: "bad-token-" + "y".repeat(30), appSecret: APP_SECRET } });
  assert.equal(badConnect.status, 400);
  assert.match(badConnect.data.error, /rejected these credentials/);
  ok("connecting with a token WhatsApp rejects is refused");

  const conn = await a.json(`/api/agents/${agentId}/whatsapp`, { method: "PUT", body: { phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET } });
  assert.equal(conn.status, 200, JSON.stringify(conn.data));
  assert.equal(conn.data.displayPhoneNumber, "+91 98765 43210");
  assert.ok(conn.data.webhookUrl.includes("/api/whatsapp/webhook/") && conn.data.verifyToken.length >= 20);
  assert.ok(!JSON.stringify(conn.data).includes(TOKEN) && !JSON.stringify(conn.data).includes(APP_SECRET));
  const hook = conn.data.webhookUrl.replace(/^https?:\/\/[^/]+/, BASE);
  ok("connect verifies the token with WhatsApp; secrets are never returned");

  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const row = (await c.query("SELECT access_token_enc, app_secret_enc FROM whatsapp_channels WHERE agent_id = $1", [agentId])).rows[0];
    await c.end();
    assert.ok(row.access_token_enc.startsWith("v1:") && !row.access_token_enc.includes(TOKEN.slice(0, 12)));
    assert.ok(row.app_secret_enc.startsWith("v1:") && !row.app_secret_enc.includes("meta-app"));
    ok("access token and app secret are encrypted at rest");
  }

  // ---- webhook verification handshake -------------------------------------------------
  const good = await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=${conn.data.verifyToken}&hub.challenge=CHALLENGE_123`);
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "CHALLENGE_123");
  assert.equal((await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`)).status, 403);
  ok("Meta verification handshake: right token echoes the challenge, wrong token gets 403");

  // ---- signature checks -----------------------------------------------------------------
  const p1 = payload(`wamid.${RUN}.AAA1`, "919811111111", text("When is the shop open?"));
  assert.equal((await deliver(hook, p1, { sign: false })).status, 401);
  assert.equal((await deliver(hook, p1, { secret: "not-the-secret" })).status, 401);
  await sleep(500);
  assert.equal(sent.length, 0, "unsigned/forged webhooks must not trigger replies");
  ok("unsigned and wrongly-signed webhooks are rejected and cause no reply");

  // ---- a real conversation ----------------------------------------------------------------
  const before = (await a.json("/api/me")).data.usage.used;
  assert.equal((await deliver(hook, p1)).status, 200);
  const r1 = await waitForReplies("919811111111", 1);
  assert.equal(r1.length, 1, "expected one reply");
  assert.match(r1[0].text.body, /8am to 10pm/);
  assert.ok(!/\[\d\]/.test(r1[0].text.body), "citation markers must be stripped for WhatsApp");
  assert.equal(r1[0].auth, `Bearer ${TOKEN}`, "decrypted token is used to send");
  assert.equal(r1[0].phoneId, PHONE_ID);
  ok(`signed message answered from the knowledge base → "${r1[0].text.body.slice(0, 60)}…"`);

  assert.equal((await deliver(hook, p1)).status, 200); // Meta re-delivers the same message
  await sleep(1500);
  assert.equal(sent.filter((s) => s.to === "919811111111").length, 1);
  ok("duplicate delivery of the same message id is ignored");

  await deliver(hook, payload(`wamid.${RUN}.AAA2`, "919811111111", text("Do you deliver to my home?")));
  assert.equal((await waitForReplies("919811111111", 2)).length, 2);
  ok("follow-up in the same chat gets a second reply");

  await deliver(hook, payload(`wamid.${RUN}.BBB1`, "919822222222", { type: "image", image: { id: "img1" } }));
  const img = await waitForReplies("919822222222", 1);
  assert.match(img[0].text.body, /only read text/);
  ok("non-text messages get a polite fallback");

  const n = sent.length;
  await deliver(hook, payload(`wamid.${RUN}.CCC1`, "919833333333", text("hello"), "999999999999999"));
  await deliver(hook, { object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: `wamid.${RUN}.S1`, status: "delivered" }] } }] }] });
  await sleep(1200);
  assert.equal(sent.length, n);
  ok("messages for another phone number id, and status-only updates, are ignored");

  // Voice notes: downloaded from WhatsApp, transcribed by Sarvam, then answered like typed text.
  await deliver(hook, payload(`wamid.${RUN}.VVV1`, "919844444444", { type: "audio", audio: { id: "media-voice1", mime_type: "audio/ogg; codecs=opus", voice: true } }));
  const voice = await waitForReplies("919844444444", 1);
  assert.match(voice[0].text.body, /8am to 10pm/, "the transcript is answered from the knowledge base");
  const upload = transcribed.at(-1);
  assert.ok(upload.includes("OggS-fake-opus-voice1") && upload.includes("saaras:v3") && upload.includes('name="mode"') && upload.includes("unknown"), upload.slice(0, 400));
  await deliver(hook, payload(`wamid.${RUN}.VVV2`, "919855555555", { type: "audio", audio: { id: "media-TOO-LONG-AUDIO", voice: true } }));
  assert.match((await waitForReplies("919855555555", 1))[0].text.body, /couldn't make out that voice note/);
  ok("voice notes are transcribed (Sarvam) and answered; ones that can't be transcribed get a polite reply");

  const usage = (await a.json("/api/me")).data.usage.used;
  // Three answered questions (two typed, one voice note) cost 3 credits; the image fallback, ignored messages and duplicates cost nothing.
  assert.equal(usage - before, 3, `expected 3 credits used, got ${usage - before}`);
  const convos = (await a.json(`/api/agents/${agentId}/conversations`)).data.conversations;
  const wa = convos.find((c) => c.contact === "+919811111111");
  assert.ok(wa && wa.message_count === 4, JSON.stringify(convos));
  const vc = convos.find((c) => c.contact === "+919844444444");
  const vmsgs = (await a.json(`/api/agents/${agentId}/conversations/${vc.id}`)).data.messages;
  assert.equal(vmsgs[0].content, "🎤 दुकान कब खुलती है? When is the shop open?", "the owner sees the transcript, marked as a voice note");
  ok("WhatsApp chats use message credits and appear in the dashboard's Chats tab");

  const leads = (await a.json(`/api/agents/${agentId}/leads`)).data.leads;
  const ravi = leads.find((l) => l.phone === "+919811111111");
  assert.ok(ravi && ravi.name === "Ravi" && ravi.source === "whatsapp", JSON.stringify(leads));
  assert.equal(leads.filter((l) => l.phone === "+919811111111").length, 1, "one lead per WhatsApp number");
  ok("WhatsApp customers are saved as leads with their number and profile name");

  // ---- isolation & lifecycle --------------------------------------------------------------------
  const b = client();
  await b.json("/api/auth/signup", { method: "POST", body: { email: `wa2${Date.now()}@example.com`, password: "another-password-1" } });
  assert.equal((await b.json(`/api/agents/${agentId}/whatsapp`)).status, 404);
  assert.equal((await b.json(`/api/agents/${agentId}/whatsapp`, { method: "DELETE" })).status, 404);
  const agentB = (await b.json("/api/agents", { method: "POST", body: { name: "Other" } })).data.agent.id;
  const dup = await b.json(`/api/agents/${agentB}/whatsapp`, { method: "PUT", body: { phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET } });
  assert.equal(dup.status, 409);
  ok("other accounts cannot see or steal this WhatsApp connection");

  assert.equal((await a.json(`/api/agents/${agentId}/whatsapp`, { method: "DELETE" })).status, 200);
  assert.equal((await deliver(hook, payload(`wamid.${RUN}.DDD1`, "919844444444", text("hi")))).status, 404);
  ok("disconnecting removes the webhook");

  console.log(`\nAll ${passed} WhatsApp checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message);
  process.exitCode = 1;
} finally {
  graph.close();
}
