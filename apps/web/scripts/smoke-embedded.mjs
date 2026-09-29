// End-to-end test of WhatsApp Embedded Signup + the platform-level webhook against a RUNNING server,
// using a local FAKE Meta Graph API. Start the app like this, then run  pnpm smoke:embedded :
//   WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4020 META_APP_ID=app_123456 META_APP_SECRET=platform-app-secret-for-tests \
//   META_ES_CONFIG_ID=cfg_987654 WHATSAPP_WEBHOOK_VERIFY_TOKEN=platform-verify-token pnpm start
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const GRAPH_PORT = Number(process.env.FAKE_GRAPH_PORT ?? 4020);
const APP_ID = "app_123456", APP_SECRET = "platform-app-secret-for-tests", CONFIG_ID = "cfg_987654", VERIFY = "platform-verify-token";
const RUN = Date.now().toString(36);
const N = String(Date.now()).slice(-9);
const PHONE = `55${N}`, WABA = `66${N}`, OTHER_WABA = `77${N}`, PHONE2 = `56${N}`, WABA2 = `67${N}`, PHONE3 = `57${N}`, WABA3 = `68${N}`;
const CODE = `code-${RUN}`, CODE2 = `code2-${RUN}`, CODE3 = `code3-${RUN}`;
const TOKEN = { [CODE]: `es-token-${RUN}-` + "a".repeat(30), [CODE2]: `es-token2-${RUN}-` + "b".repeat(30), [CODE3]: `es-token3-${RUN}-` + "c".repeat(30) };
const OWNERS = { [PHONE]: WABA, [PHONE2]: WABA2, [PHONE3]: WABA3 }; // phone -> waba, per the fake Meta
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake Meta Graph API ---------------------------------------------------------------------------------
const calls = [];
const sent = [];
let failSubscribeFor = null;
let failRegisterFor = null;
const graph = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    const bearer = (req.headers.authorization ?? "").replace("Bearer ", "");
    const tokens = Object.values(TOKEN);
    const err = (status, message) => ((res.statusCode = status), res.end(JSON.stringify({ error: { message } })));
    calls.push({ method: req.method, path, bearer, body: body ? JSON.parse(body) : null, query: Object.fromEntries(url.searchParams) });

    if (req.method === "GET" && path === "/oauth/access_token") {
      const q = Object.fromEntries(url.searchParams);
      if (q.client_id !== APP_ID || q.client_secret !== APP_SECRET) return err(400, "Invalid client credentials");
      if (!TOKEN[q.code]) return err(400, "This authorization code has expired or is invalid.");
      return res.end(JSON.stringify({ access_token: TOKEN[q.code], token_type: "bearer" }));
    }
    if (!tokens.includes(bearer)) return err(401, "Invalid OAuth access token.");
    const tokenPhone = Object.entries(TOKEN).find(([, t]) => t === bearer)[0];
    const myPhone = { [CODE]: PHONE, [CODE2]: PHONE2, [CODE3]: PHONE3 }[tokenPhone];
    let m;
    if (req.method === "GET" && (m = path.match(/^\/(\d+)$/))) {
      if (m[1] !== myPhone) return err(403, "(#10) Application does not have permission for this action");
      return res.end(JSON.stringify({ id: m[1], display_phone_number: "+91 90000 11111", verified_name: "Priya Sweets" }));
    }
    if (req.method === "GET" && (m = path.match(/^\/(\d+)\/phone_numbers$/))) {
      const phones = Object.entries(OWNERS).filter(([p, w]) => w === m[1] && p === myPhone).map(([p]) => ({ id: p }));
      return res.end(JSON.stringify({ data: phones }));
    }
    if (req.method === "POST" && (m = path.match(/^\/(\d+)\/subscribed_apps$/))) {
      if (failSubscribeFor === m[1]) return err(400, "Subscription refused");
      return res.end(JSON.stringify({ success: true }));
    }
    if (req.method === "DELETE" && path.match(/^\/(\d+)\/subscribed_apps$/)) return res.end(JSON.stringify({ success: true }));
    if (req.method === "POST" && (m = path.match(/^\/(\d+)\/register$/))) {
      if (failRegisterFor === m[1]) return err(400, "Phone number is already registered");
      return res.end(JSON.stringify({ success: true }));
    }
    if (req.method === "POST" && (m = path.match(/^\/(\d+)\/messages$/))) {
      const j = JSON.parse(body);
      sent.push({ phoneId: m[1], bearer, ...j });
      return res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.${RUN}.OUT${sent.length}` }] }));
    }
    return err(404, "Unknown fake-Graph route " + req.method + " " + path);
  });
});
await new Promise((r) => graph.listen(GRAPH_PORT, "127.0.0.1", r));

// ---- helpers ---------------------------------------------------------------------------------------------------
function client() {
  let cookie = "";
  return {
    async json(path, { method = "GET", body } = {}) {
      const res = await fetch(BASE + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return { status: res.status, data: await res.json().catch(() => ({})) };
    },
  };
}
let wn = 0;
const payload = (phoneId, from, body) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "919000011111", phone_number_id: phoneId }, contacts: [{ profile: { name: "Ravi" }, wa_id: from }], messages: [{ from, id: `wamid.${RUN}.IN${++wn}`, timestamp: "1700000000", type: "text", text: { body } }] } }] }],
});
async function post(url, obj, secret = APP_SECRET, sign = true) {
  const raw = JSON.stringify(obj);
  const headers = { "content-type": "application/json" };
  if (sign) headers["x-hub-signature-256"] = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return fetch(url, { method: "POST", headers, body: raw });
}
async function waitSent(phoneId, count, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const mine = sent.filter((s) => s.phoneId === phoneId);
    if (mine.length >= count) return mine;
    await sleep(100);
  }
  return sent.filter((s) => s.phoneId === phoneId);
}
const HOOK = `${BASE}/api/whatsapp/webhook`;

let db;
try {
  console.log(`Embedded Signup smoke test against ${BASE} (fake Graph :${GRAPH_PORT})`);
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }
  const a = client();
  const b = client();
  await a.json("/api/auth/signup", { method: "POST", body: { email: `es${Date.now()}@example.com`, password: "correct-horse-battery" } });
  await b.json("/api/auth/signup", { method: "POST", body: { email: `es2${Date.now()}@example.com`, password: "correct-horse-battery" } });
  const agentId = (await a.json("/api/agents", { method: "POST", body: { name: "Priya Sweets Bot" } })).data.agent.id;
  await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "text", title: "Shop", text: "Priya Sweets sells fresh ladoo and barfi. Our shop is closed on Mondays. Diwali gift boxes start at 500 rupees." } });
  for (let i = 0; i < 40; i++) {
    if ((await a.json(`/api/agents/${agentId}/sources`)).data.sources.every((s) => s.status === "ready")) break;
    await sleep(250);
  }

  // ---- availability ---------------------------------------------------------------------------------------------
  const st0 = await a.json(`/api/agents/${agentId}/whatsapp`);
  assert.deepEqual({ ...st0.data.embedded }, { available: true, appId: APP_ID, configId: CONFIG_ID, graphVersion: st0.data.embedded.graphVersion });
  assert.ok(!JSON.stringify(st0.data).includes(APP_SECRET));
  ok("the dashboard is told the app id and config id to open the popup, and never the app secret");

  // ---- signup ---------------------------------------------------------------------------------------------------------
  const body = (over = {}) => ({ code: CODE, phoneNumberId: PHONE, wabaId: WABA, businessId: "9000123", ...over });
  const ep = `/api/agents/${agentId}/whatsapp/embedded`;
  assert.equal((await a.json(ep, { method: "POST", body: body({ code: "expired-code" }) })).status, 400);
  assert.match((await a.json(ep, { method: "POST", body: body({ code: "expired-code" }) })).data.error, /expired|rejected/i);
  assert.equal((await a.json(ep, { method: "POST", body: { code: CODE } })).status, 400);
  assert.equal((await fetch(BASE + ep, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) })).status, 401);
  ok("bad or expired codes, missing fields and anonymous callers are refused");

  assert.equal((await a.json(ep, { method: "POST", body: body({ wabaId: OTHER_WABA }) })).status, 400);
  assert.equal((await a.json(`/api/agents/${agentId}/whatsapp`)).data.connected, false);
  ok("a phone number that isn't in the reported WhatsApp account is refused (client-supplied ids aren't trusted)");

  failSubscribeFor = WABA;
  assert.equal((await a.json(ep, { method: "POST", body: body() })).status, 502);
  assert.equal((await a.json(`/api/agents/${agentId}/whatsapp`)).data.connected, false);
  failSubscribeFor = null;
  ok("if Meta refuses the message subscription nothing is saved (a number that can't receive is useless)");

  calls.length = 0;
  const done = await a.json(ep, { method: "POST", body: body() });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.displayPhoneNumber, "+91 90000 11111");
  const exch = calls.find((c) => c.path === "/oauth/access_token");
  assert.ok(exch && exch.query.client_secret === APP_SECRET && exch.query.code === CODE, "the code is exchanged server-side with the app secret");
  const sub = calls.find((c) => c.method === "POST" && c.path === `/${WABA}/subscribed_apps`);
  assert.equal(sub?.bearer, TOKEN[CODE]);
  const reg = calls.find((c) => c.method === "POST" && c.path === `/${PHONE}/register`);
  assert.ok(reg && reg.body.messaging_product === "whatsapp" && /^\d{6}$/.test(reg.body.pin));
  const st1 = (await a.json(`/api/agents/${agentId}/whatsapp`)).data;
  assert.equal(st1.connected, true);
  assert.equal(st1.source, "embedded");
  assert.ok(!st1.webhookUrl && !st1.verifyToken, "no webhook details to copy for Embedded Signup numbers");
  assert.ok(!JSON.stringify(st1).includes(TOKEN[CODE]));
  ok("signup: code exchanged server-side, number checked, app subscribed, number registered, connection saved");

  if (db) {
    const row = (await db.query("SELECT access_token_enc, app_secret_enc, registration_pin_enc, waba_id, source FROM whatsapp_channels WHERE agent_id = $1", [agentId])).rows[0];
    assert.equal(row.source, "embedded");
    assert.equal(row.waba_id, WABA);
    assert.equal(row.app_secret_enc, null);
    assert.ok(row.access_token_enc.startsWith("v1:") && !row.access_token_enc.includes("es-token"));
    assert.ok(row.registration_pin_enc.startsWith("v1:"));
    ok("the customer's token and registration PIN are encrypted at rest; no per-channel app secret is stored");
  }

  // ---- platform webhook ------------------------------------------------------------------------------------------------
  const okChallenge = await fetch(`${HOOK}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=CH_42`);
  assert.equal(okChallenge.status, 200);
  assert.equal(await okChallenge.text(), "CH_42");
  assert.equal((await fetch(`${HOOK}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=x`)).status, 403);
  assert.equal((await fetch(`${HOOK}?hub.mode=subscribe&hub.challenge=x`)).status, 403);
  ok("platform webhook: Meta's verification handshake works with WHATSAPP_WEBHOOK_VERIFY_TOKEN only");

  const p1 = payload(PHONE, "919811111111", "Is the shop open on Monday?");
  assert.equal((await post(HOOK, p1, APP_SECRET, false)).status, 401);
  assert.equal((await post(HOOK, p1, "wrong-secret")).status, 401);
  await sleep(400);
  assert.equal(sent.length, 0);
  assert.equal((await post(HOOK, p1)).status, 200);
  const r1 = await waitSent(PHONE, 1);
  assert.equal(r1.length, 1);
  assert.match(r1[0].text.body, /closed on Mondays/i);
  assert.equal(r1[0].bearer, TOKEN[CODE], "the reply is sent with this customer's own token");
  assert.equal((await post(HOOK, p1)).status, 200);
  await sleep(600);
  assert.equal(sent.length, 1, "a duplicate delivery must not be answered twice");
  ok("platform webhook: signed message is answered with the customer's token; forged and duplicate deliveries are ignored");

  assert.equal((await post(HOOK, payload("999000111222", "919822222222", "hello"))).status, 200);
  await sleep(600);
  assert.equal(sent.length, 1, "messages for numbers we don't serve are ignored");
  ok("messages for an unknown phone number are acknowledged and ignored");

  // ---- tenant isolation & duplicates -----------------------------------------------------------------------------------
  const agentB = (await b.json("/api/agents", { method: "POST", body: { name: "Other Bot" } })).data.agent.id;
  const steal = await b.json(`/api/agents/${agentB}/whatsapp/embedded`, { method: "POST", body: body() });
  assert.equal(steal.status, 409, JSON.stringify(steal.data));
  assert.match(steal.data.error, /already connected/);
  ok("the same phone number cannot be connected to two agents");
  assert.equal((await b.json(`/api/agents/${agentId}/whatsapp/embedded`, { method: "POST", body: body({ code: CODE2, phoneNumberId: PHONE2, wabaId: WABA2 }) })).status, 404);
  ok("other accounts cannot connect a number to someone else's agent");

  // ---- register failure is a warning, not an error ---------------------------------------------------------------------
  failRegisterFor = PHONE3;
  const warn = await b.json(`/api/agents/${agentB}/whatsapp/embedded`, { method: "POST", body: { code: CODE3, phoneNumberId: PHONE3, wabaId: WABA3 } });
  assert.equal(warn.status, 200, JSON.stringify(warn.data));
  assert.match(warn.data.warning, /already registered/);
  failRegisterFor = null;
  ok("if the number was already registered the connection still succeeds, with a warning for the owner");

  // ---- the per-channel manual webhook still works for manual channels (covered by smoke:whatsapp) ------------------------
  // ---- disconnect ---------------------------------------------------------------------------------------------------------
  calls.length = 0;
  assert.equal((await a.json(`/api/agents/${agentId}/whatsapp`, { method: "DELETE" })).status, 200);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === `/${WABA}/subscribed_apps` && c.bearer === TOKEN[CODE]), "unsubscribes the WABA");
  assert.equal((await a.json(`/api/agents/${agentId}/whatsapp`)).data.connected, false);
  const before = sent.length;
  await post(HOOK, payload(PHONE, "919811111111", "still there?"));
  await sleep(700);
  assert.equal(sent.length, before);
  ok("disconnecting unsubscribes the account at Meta and stops replies");

  console.log(`\nAll ${passed} Embedded Signup checks passed.`);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exitCode = 1;
} finally {
  await db?.end().catch(() => {});
  graph.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
