// End-to-end test of answer feedback, answer fixes, analytics and lead capture against a RUNNING server
// (mock models are enough):  pnpm build && pnpm start  , then  pnpm smoke:features
import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const IP = `10.88.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // fresh rate-limit buckets per run
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = () => crypto.randomBytes(12).toString("hex");

function client() {
  let cookie = "";
  return {
    cookie: () => cookie,
    async req(path, { method = "GET", body, headers = {} } = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: { "x-forwarded-for": IP, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return res;
    },
    async json(path, opts) {
      const res = await this.req(path, opts);
      return { status: res.status, data: await res.json().catch(() => ({})) };
    },
  };
}

/** Sends a widget (or playground, with the owner's cookie) message and collects the streamed events. */
async function chat(agentId, sessionId, message, { channel = "widget", cookie = "" } = {}) {
  const res = await fetch(`${BASE}/api/chat/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": IP, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ message, sessionId, channel }),
  });
  if (!res.ok) return { status: res.status, error: (await res.json()).error };
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const done = events.find((e) => e.type === "done");
  return { status: res.status, text: events.filter((e) => e.type === "delta").map((e) => e.text).join(""), done, events };
}

async function waitReady(c, agentId) {
  for (let i = 0; i < 100; i++) {
    const { data } = await c.json(`/api/agents/${agentId}/sources`);
    if (!data.sources.some((s) => s.status === "processing")) return data.sources;
    await sleep(300);
  }
  throw new Error("ingestion timed out");
}

try {
  console.log(`Features smoke test against ${BASE}\n`);
  const a = client();
  await a.json("/api/auth/signup", { method: "POST", body: { email: `feat${Date.now()}@example.com`, password: "password-123" } });
  const agentId = (await a.json("/api/agents", { method: "POST", body: { name: "Feature Bot" } })).data.agent.id;
  await a.json(`/api/agents/${agentId}/sources`, {
    method: "POST",
    body: { type: "text", title: "FAQ", text: "Delivery: we deliver across India in 3 to 5 working days. Returns are accepted within 7 days of delivery." },
  });
  await waitReady(a, agentId);

  // ---- 👍 / 👎 feedback ------------------------------------------------------------------------------
  const S1 = sid();
  const r1 = await chat(agentId, S1, "How long does delivery take?");
  assert.ok(Number.isInteger(r1.done?.messageId), JSON.stringify(r1.done));
  const rate = (sessionId, messageId, rating) => client().json(`/api/chat/${agentId}/feedback`, { method: "POST", body: { sessionId, messageId, rating } });
  assert.equal((await rate(S1, r1.done.messageId, "down")).status, 200);
  assert.equal((await rate(sid(), r1.done.messageId, "up")).status, 404, "another visitor must not rate this answer");
  const restored = (await client().json(`/api/chat/${agentId}/messages?sessionId=${S1}&all=1`)).data.messages;
  const answer = restored.find((m) => Number(m.id) === r1.done.messageId);
  assert.equal(answer.feedback, -1);
  assert.equal(answer.rateable, true);
  assert.equal(restored.find((m) => m.role === "user").rateable, false);
  ok("visitors can rate answers 👍/👎 (only in their own conversation); the rating survives a reload");

  const list = (await a.json(`/api/agents/${agentId}/conversations`)).data.conversations;
  assert.equal(list.find((c) => c.thumbs_down === 1)?.message_count, 2);
  const convoId = list.find((c) => c.thumbs_down === 1).id;
  const detail = (await a.json(`/api/agents/${agentId}/conversations/${convoId}`)).data.messages;
  assert.equal(detail.find((m) => m.role === "assistant").feedback, -1);
  assert.equal((await rate(S1, r1.done.messageId, null)).status, 200);
  ok("the owner sees 👎 answers in the inbox; a rating can be cleared");

  // ---- Fix this answer (owner Q&A) -------------------------------------------------------------------
  const fixRes = await a.json(`/api/agents/${agentId}/fixes`, {
    method: "POST",
    body: { question: "How long does delivery take?", answer: "Delivery now takes just 2 days, free of charge.", messageId: r1.done.messageId },
  });
  assert.equal(fixRes.status, 201, JSON.stringify(fixRes.data));
  const fixId = fixRes.data.fix.id;
  const fixed = await chat(agentId, sid(), "how long does delivery take");
  assert.ok(fixed.text.includes("2 days, free of charge"), fixed.text);
  assert.deepEqual(fixed.done.citations, []);
  const other = await chat(agentId, sid(), "Are returns accepted?");
  assert.ok(other.text.includes("Returns are accepted within 7 days"), other.text);
  assert.ok(other.done.citations.length >= 1);
  ok("a fixed answer wins for the same question (without unrelated citations); other questions still use the sources");

  const marked = (await a.json(`/api/agents/${agentId}/conversations/${convoId}`)).data.messages.find((m) => m.role === "assistant");
  assert.equal(marked.bot, true);
  assert.equal(marked.fixed, true);
  const pg = await chat(agentId, sid(), "How long does delivery take?", { channel: "playground", cookie: a.cookie() });
  assert.ok(pg.text.includes("2 days"), pg.text);
  ok("the inbox marks the corrected answer; the playground uses fixes too");

  assert.equal((await a.json(`/api/agents/${agentId}/fixes/${fixId}`, { method: "PATCH", body: { question: "How long does delivery take?", answer: "Delivery takes 1 day in metros." } })).status, 200);
  assert.ok((await chat(agentId, sid(), "How long does delivery take?")).text.includes("1 day in metros"));
  assert.equal((await a.json(`/api/agents/${agentId}/fixes/${fixId}`, { method: "DELETE" })).status, 200);
  assert.ok((await chat(agentId, sid(), "How long does delivery take?")).text.includes("3 to 5 working days"));
  ok("editing a Q&A answer takes effect at once; deleting it goes back to the sources");

  const b = client();
  await b.json("/api/auth/signup", { method: "POST", body: { email: `feat-b${Date.now()}@example.com`, password: "password-123" } });
  assert.equal((await b.json(`/api/agents/${agentId}/fixes`)).status, 404);
  const bAgent = (await b.json("/api/agents", { method: "POST", body: { name: "B" } })).data.agent.id;
  assert.equal((await b.json(`/api/agents/${bAgent}/fixes`, { method: "POST", body: { question: "steal?", answer: "x", messageId: r1.done.messageId } })).status, 404);
  assert.equal((await a.json(`/api/agents/${agentId}/fixes`, { method: "POST", body: { question: "", answer: "" } })).status, 400);
  ok("Q&A answers are private to the agent's owner and validated");

  console.log(`\nAll ${passed} feature checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
}
