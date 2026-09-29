// End-to-end test of human handoff against a RUNNING server, using a fake Meta Graph API and a fake SMTP server.
// Start the app like this, then run  pnpm smoke:handoff  (DATABASE_URL from .env is used for two extra checks):
//   WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4020 SMTP_URL=smtp://127.0.0.1:4025 EMAIL_FROM="Bot <bot@example.com>" pnpm start
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const GRAPH_PORT = Number(process.env.FAKE_GRAPH_PORT ?? 4020);
const SMTP_PORT = Number(process.env.FAKE_SMTP_PORT ?? 4025);
const TOKEN = "good-token-" + "x".repeat(30);
const APP_SECRET = "meta-app-secret-for-tests";
const RUN = Date.now().toString(36);
const PHONE_ID = `1097${Date.now()}`;
const FAIL_TO = "919833333333"; // the fake Graph API refuses to deliver to this number (simulates the 24-hour window)
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = () => crypto.randomBytes(12).toString("hex");

// ---- fake Meta Graph API -------------------------------------------------------------------------
const sent = [];
const graph = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return (res.statusCode = 401), res.end(JSON.stringify({ error: { message: "Invalid OAuth access token." } }));
    const m = req.url.match(/^\/v[\d.]+\/(\d+)(\/messages)?(\?.*)?$/);
    if (!m) return (res.statusCode = 404), res.end("{}");
    if (req.method === "GET" && !m[2]) return res.end(JSON.stringify({ id: m[1], display_phone_number: "+91 98765 43210", verified_name: "Sharma Kirana" }));
    if (req.method === "POST" && m[2]) {
      const j = JSON.parse(body);
      if (j.to === FAIL_TO) return (res.statusCode = 400), res.end(JSON.stringify({ error: { message: "(#131047) Re-engagement message" } }));
      sent.push({ phoneId: m[1], ...j });
      return res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.${RUN}.OUT${sent.length}` }] }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => graph.listen(GRAPH_PORT, "127.0.0.1", r));

// ---- fake SMTP server (records every message) ------------------------------------------------------
const mails = [];
function decodeBody(raw) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  let body = rest.join("\n\n");
  if (/content-transfer-encoding:\s*base64/i.test(head)) body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  else if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
    const bytes = [];
    const s = body.replace(/=\r?\n/g, "");
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) (bytes.push(parseInt(s.slice(i + 1, i + 3), 16)), (i += 2));
      else bytes.push(...Buffer.from(s[i]));
    }
    body = Buffer.from(bytes).toString("utf8");
  }
  const header = (n) => (head.match(new RegExp(`^${n}:\\s*(.*)$`, "im")) ?? [])[1] ?? "";
  return { to: header("To"), subject: header("Subject"), body };
}
const smtp = net.createServer((sock) => {
  let buf = "";
  let inData = false;
  let data = "";
  sock.write("220 fake ESMTP\r\n");
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        data += buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        mails.push(decodeBody(data));
        data = "";
        sock.write("250 queued\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250 fake\r\n");
      else if (cmd === "DATA") (inData = true), sock.write("354 go\r\n");
      else if (cmd === "QUIT") (sock.write("221 bye\r\n"), sock.end());
      else sock.write("250 OK\r\n");
    }
  });
  sock.on("error", () => {});
});
await new Promise((r) => smtp.listen(SMTP_PORT, "127.0.0.1", r));
async function waitMails(n, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout && mails.length < n) await sleep(100);
  return mails.length;
}

// ---- helpers ---------------------------------------------------------------------------------------------
function client() {
  let cookie = "";
  return {
    cookie: () => cookie,
    async json(path, { method = "GET", body } = {}) {
      const res = await fetch(BASE + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return { status: res.status, data: await res.json().catch(() => ({})) };
    },
  };
}
const pub = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { method: opts.method ?? "GET", headers: opts.body ? { "content-type": "application/json" } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
/** Widget chat call: returns the NDJSON events. */
async function chat(agentId, sessionId, message, channel = "widget", cookie = "") {
  const res = await fetch(`${BASE}/api/chat/${agentId}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ message, sessionId, channel }) });
  assert.equal(res.status, 200, `chat failed: ${res.status}`);
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { events, answer: events.filter((e) => e.type === "delta").map((e) => e.text).join(""), handoff: events.find((e) => e.type === "handoff") };
}
const payload = (wamid, from, msg) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "919876543210", phone_number_id: PHONE_ID }, contacts: [{ profile: { name: "Ravi" }, wa_id: from }], messages: [{ from, id: wamid, timestamp: "1700000000", ...msg }] } }] }],
});
const text = (body) => ({ type: "text", text: { body } });
let wn = 0;
async function deliver(hook, from, msg) {
  const raw = JSON.stringify(payload(`wamid.${RUN}.H${++wn}`, from, msg));
  const res = await fetch(hook, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex") }, body: raw });
  assert.equal(res.status, 200);
}
async function waitSent(to, count, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const mine = sent.filter((s) => s.to === to);
    if (mine.length >= count) return mine;
    await sleep(100);
  }
  return sent.filter((s) => s.to === to);
}

let db;
try {
  console.log(`Human-handoff smoke test against ${BASE} (fake Graph :${GRAPH_PORT}, fake SMTP :${SMTP_PORT})`);
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }

  const a = client();
  const b = client();
  const emailA = `owner${Date.now()}@example.com`;
  await a.json("/api/auth/signup", { method: "POST", body: { email: emailA, password: "correct-horse-battery" } });
  await b.json("/api/auth/signup", { method: "POST", body: { email: `other${Date.now()}@example.com`, password: "correct-horse-battery" } });
  const agentId = (await a.json("/api/agents", { method: "POST", body: { name: "Kirana Bot" } })).data.agent.id;
  await a.json(`/api/agents/${agentId}/sources`, {
    method: "POST",
    body: { type: "text", title: "Store info", text: "Our shop Sharma Kirana is open from 8am to 10pm every day. We offer free home delivery within 3 km for orders above 300 rupees." },
  });
  for (let i = 0; i < 40; i++) {
    if ((await a.json(`/api/agents/${agentId}/sources`)).data.sources.every((s) => s.status === "ready")) break;
    await sleep(250);
  }
  const used = async () => (await a.json("/api/me")).data.usage.used;
  const convos = async () => (await a.json(`/api/agents/${agentId}/conversations`)).data.conversations;

  // ---- website widget ------------------------------------------------------------------------------
  const S1 = sid();
  const q1 = await chat(agentId, S1, "When is the shop open?");
  assert.match(q1.answer, /8am to 10pm/);
  assert.equal(q1.handoff, undefined);
  const u0 = await used();
  ok("normal questions are still answered by the assistant");

  const h1 = await chat(agentId, S1, "I want to talk to a human");
  assert.ok(h1.handoff?.notice?.length > 10, "handoff notice expected");
  assert.equal(h1.answer, "", "the bot must not answer once a person is requested");
  assert.equal(await used(), u0, "handing off costs no credit");
  let list = await convos();
  assert.equal(list[0].needs_reply, true);
  assert.equal(list[0].mode, "human");
  assert.equal((await a.json("/api/agents")).data.agents[0].waiting_count, 1);
  ok("asking for a person hands the chat over: no bot reply, no credit used, flagged as waiting");

  assert.equal(await waitMails(1), 1, "owner should be e-mailed");
  const m1 = mails[0];
  assert.ok(m1.to.includes(emailA) && m1.subject.includes("Kirana Bot"), `${m1.to} / ${m1.subject}`);
  assert.ok(m1.body.includes("talk to a human") && m1.body.includes(`/dashboard/agents/${agentId}?c=${list[0].id}#chats`), m1.body);
  ok("the owner gets an e-mail with the customer's message and a link straight to the chat");

  const h2 = await chat(agentId, S1, "hello? anyone there?");
  assert.equal(h2.handoff?.notice, null, "the notice is only shown once");
  assert.equal(h2.answer, "");
  assert.equal(await used(), u0);
  await sleep(600);
  assert.equal(mails.length, 1, "no e-mail flood for follow-up messages");
  ok("follow-up messages are stored silently (no bot, no credit, no repeat e-mail)");

  const poll0 = await pub(`/api/chat/${agentId}/messages?sessionId=${S1}&after=0`);
  assert.equal(poll0.data.mode, "human");
  assert.equal(poll0.data.messages.length, 0);

  const cid = list[0].id;
  const rep = await a.json(`/api/agents/${agentId}/conversations/${cid}/reply`, { method: "POST", body: { message: "Hi, this is Ramesh from the shop. How can I help?" } });
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  const poll1 = await pub(`/api/chat/${agentId}/messages?sessionId=${S1}&after=0`);
  assert.equal(poll1.data.messages.length, 1);
  assert.equal(poll1.data.messages[0].role, "human");
  assert.match(poll1.data.messages[0].content, /Ramesh/);
  assert.equal((await pub(`/api/chat/${agentId}/messages?sessionId=${S1}&after=${poll1.data.messages[0].id}`)).data.messages.length, 0);
  assert.equal((await convos())[0].needs_reply, false);
  assert.equal((await convos())[0].mode, "human");
  ok("the owner's reply reaches the visitor (poll) and clears the 'waiting' flag");

  await chat(agentId, S1, "I need my order delivered today");
  assert.equal((await convos())[0].needs_reply, true);
  ok("a new customer message while a person is handling the chat flags it as waiting again");

  const all = await pub(`/api/chat/${agentId}/messages?sessionId=${S1}&all=1`);
  assert.deepEqual(all.data.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "human", "user"]);
  assert.equal((await pub(`/api/chat/${agentId}/messages?sessionId=${sid()}&all=1`)).data.messages.length, 0);
  ok("a reloaded widget can restore the whole conversation (and a stranger's session id shows nothing)");

  // tenant isolation
  const detail = await b.json(`/api/agents/${agentId}/conversations/${cid}`);
  assert.equal(detail.status, 404);
  assert.equal((await b.json(`/api/agents/${agentId}/conversations/${cid}/reply`, { method: "POST", body: { message: "hijack" } })).status, 404);
  assert.equal((await b.json(`/api/agents/${agentId}/conversations/${cid}`, { method: "PATCH", body: { mode: "bot" } })).status, 404);
  assert.equal((await pub(`/api/agents/${agentId}/conversations/${cid}/reply`, { method: "POST", body: { message: "x" } })).status, 401);
  ok("other accounts and anonymous users cannot read, reply to or change a conversation");

  const back = await a.json(`/api/agents/${agentId}/conversations/${cid}`, { method: "PATCH", body: { mode: "bot" } });
  assert.equal(back.data.conversation.mode, "bot");
  assert.equal(back.data.conversation.needs_reply, false);
  assert.equal((await pub(`/api/chat/${agentId}/messages?sessionId=${S1}&after=999999999`)).data.mode, "bot");
  const q2 = await chat(agentId, S1, "Is there free delivery?");
  assert.match(q2.answer, /free home delivery/i);
  assert.equal(q2.handoff, undefined);
  assert.equal(await used(), u0 + 1);
  ok("handing back to the assistant resumes bot answers (and credits)");

  // "Talk to a human" button + contact details
  const S2 = sid();
  const btn = await pub(`/api/chat/${agentId}/handoff`, { method: "POST", body: { sessionId: S2 } });
  assert.equal(btn.status, 200);
  assert.ok(btn.data.notice && btn.data.mode === "human");
  assert.equal(await waitMails(2), 2);
  const c1 = await pub(`/api/chat/${agentId}/handoff`, { method: "POST", body: { sessionId: S2, contact: "98110 22222" } });
  assert.equal(c1.status, 200);
  assert.equal(c1.data.notice, null);
  assert.equal(await waitMails(3), 3);
  assert.match(mails[2].subject, /contact details/);
  assert.ok(mails[2].body.includes("98110 22222"));
  await pub(`/api/chat/${agentId}/handoff`, { method: "POST", body: { sessionId: S2, contact: "98110 33333" } });
  await sleep(600);
  assert.equal(mails.length, 3, "changing contact details again must not send another e-mail");
  assert.equal((await convos()).find((c) => c.contact === "98110 33333")?.needs_reply, true);
  assert.equal((await pub(`/api/chat/${agentId}/handoff`, { method: "POST", body: { sessionId: "short" } })).status, 400);
  ok("the 'Talk to a human' button works and the visitor can leave a phone number / e-mail (one e-mail only)");

  // owner takes over a bot conversation proactively
  const S3 = sid();
  await chat(agentId, S3, "What are your timings?");
  const c3 = (await convos()).find((c) => c.first_message === "What are your timings?");
  assert.ok(c3);
  await a.json(`/api/agents/${agentId}/conversations/${c3.id}/reply`, { method: "POST", body: { message: "Open till 10, see you!" } });
  const u1 = await used();
  const t3 = await chat(agentId, S3, "thanks, and is there parking?");
  assert.equal(t3.answer, "");
  assert.equal(await used(), u1);
  ok("when the owner replies on their own, the assistant stops talking over them");

  // playground never hands off
  const pg = await chat(agentId, sid(), "talk to a human", "playground", a.cookie());
  assert.equal(pg.handoff, undefined);
  assert.ok(pg.answer.length > 0);
  ok("the dashboard playground is never handed off (the owner is testing)");

  // settings
  assert.equal((await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { handoffMessage: "" } })).status, 400);
  await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { handoffMessage: "Ramesh will reply here soon 🙏", notifyEmail: false } });
  await sleep(500);
  const mailsNow = mails.length; // (the S3 customer message above legitimately e-mailed the owner once)
  const S4 = sid();
  const custom = await pub(`/api/chat/${agentId}/handoff`, { method: "POST", body: { sessionId: S4 } });
  assert.equal(custom.data.notice, "Ramesh will reply here soon 🙏");
  await sleep(700);
  assert.equal(mails.length, mailsNow, "notify_email=false stops the e-mails");
  await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { handoffEnabled: false } });
  const off = await chat(agentId, sid(), "I want to talk to a human");
  assert.equal(off.handoff, undefined);
  assert.ok(off.answer.length > 0);
  assert.equal((await pub(`/api/chat/${agentId}/handoff`, { method: "POST", body: { sessionId: sid() } })).status, 403);
  await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { handoffEnabled: true, notifyEmail: true } });
  ok("settings: custom notice, e-mail switch and turning handoff off all take effect");

  if (db) {
    const S5 = sid();
    await chat(agentId, S5, "human please");
    await db.query("UPDATE conversations SET needs_reply_at = now() - interval '25 hours' WHERE agent_id = $1 AND session_id = $2", [agentId, S5]);
    const r = await chat(agentId, S5, "Is there free delivery?");
    assert.equal(r.handoff, undefined);
    assert.match(r.answer, /free home delivery/i);
    ok("a customer nobody answered for 24 hours is picked up by the assistant again");
  }

  // ---- WhatsApp --------------------------------------------------------------------------------------------
  const conn = await a.json(`/api/agents/${agentId}/whatsapp`, { method: "PUT", body: { phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET } });
  assert.equal(conn.status, 200, JSON.stringify(conn.data));
  const hook = conn.data.webhookUrl.replace(/^https?:\/\/[^/]+/, BASE);
  const mailsBefore = mails.length;
  const W = "919822222222";

  await deliver(hook, W, text("Human"));
  const w1 = await waitSent(W, 1);
  assert.equal(w1.length, 1);
  assert.equal(w1[0].text.body, "Ramesh will reply here soon 🙏");
  const wc = (await convos()).find((c) => c.contact === `+${W}`);
  assert.ok(wc && wc.needs_reply && wc.mode === "human" && wc.channel === "whatsapp");
  assert.equal(await waitMails(mailsBefore + 1), mailsBefore + 1);
  assert.ok(mails.at(-1).body.includes("WhatsApp") && mails.at(-1).body.includes(`+${W}`));
  ok("WhatsApp: typing “human” sends the notice, flags the chat and e-mails the owner with the phone number");

  await deliver(hook, W, text("where is my order??"));
  await deliver(hook, W, { type: "image", image: { id: "MEDIA1" } });
  await sleep(1200);
  assert.equal(sent.filter((s) => s.to === W).length, 1, "the bot must stay silent (no answer, no 'text only' fallback)");
  const wd = (await a.json(`/api/agents/${agentId}/conversations/${wc.id}`)).data;
  assert.ok(wd.messages.some((m) => m.content.includes("image message")));
  ok("WhatsApp: while a person handles the chat the bot is silent, and photos/voice notes are recorded for the owner");

  const wr = await a.json(`/api/agents/${agentId}/conversations/${wc.id}/reply`, { method: "POST", body: { message: "Namaste! Your order ships today." } });
  assert.equal(wr.status, 200, JSON.stringify(wr.data));
  const w2 = await waitSent(W, 2);
  assert.equal(w2[1].text.body, "Namaste! Your order ships today.");
  assert.equal(w2[1].phoneId ?? PHONE_ID, PHONE_ID);
  ok("WhatsApp: the owner's dashboard reply is delivered to the customer's WhatsApp");

  // a reply WhatsApp refuses to deliver is an error for the owner and is NOT saved
  await deliver(hook, FAIL_TO, text("human"));
  await sleep(500);
  const fc = (await convos()).find((c) => c.contact === `+${FAIL_TO}`);
  assert.ok(fc);
  const nBefore = (await a.json(`/api/agents/${agentId}/conversations/${fc.id}`)).data.messages.length;
  const bad = await a.json(`/api/agents/${agentId}/conversations/${fc.id}/reply`, { method: "POST", body: { message: "hello" } });
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /24 hours/);
  assert.equal((await a.json(`/api/agents/${agentId}/conversations/${fc.id}`)).data.messages.length, nBefore);
  ok("WhatsApp: a reply WhatsApp cannot deliver shows an error to the owner and is not recorded as sent");

  await a.json(`/api/agents/${agentId}/conversations/${wc.id}`, { method: "PATCH", body: { mode: "bot" } });
  await deliver(hook, W, text("Is there free delivery?"));
  const w3 = await waitSent(W, 3);
  assert.match(w3[2].text.body, /free home delivery/i);
  ok("WhatsApp: after handing back, the assistant answers again");
  console.log(`\nAll ${passed} handoff checks passed.`);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exitCode = 1;
} finally {
  await db?.end().catch(() => {});
  graph.close();
  smtp.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
