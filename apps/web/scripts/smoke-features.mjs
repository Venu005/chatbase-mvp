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

  // ---- Analytics ------------------------------------------------------------------------------------
  const gapQ = "Do you sell gift cards?";
  await chat(agentId, sid(), gapQ);
  await chat(agentId, sid(), "do you sell gift cards?  ");
  await chat(agentId, sid(), "Do you sell gift cards?", { channel: "playground", cookie: a.cookie() }); // owner test: not counted
  const S9 = sid();
  const r9 = await chat(agentId, S9, "Are returns accepted?");
  await rate(S9, r9.done.messageId, "down");
  const an = (await a.json(`/api/agents/${agentId}/analytics?days=7`)).data;
  assert.equal(an.series.length, 7);
  assert.equal(an.series.at(-1).conversations, an.totals.conversations, "all of today's conversations are in today's column");
  assert.ok(!an.channels.some((c) => c.channel === "playground"));
  const widgetConvos = (await a.json(`/api/agents/${agentId}/conversations`)).data.conversations.filter((c) => c.channel === "widget").length;
  assert.equal(an.totals.conversations, widgetConvos);
  const gap = an.gaps.find((g) => g.question.toLowerCase().startsWith("do you sell gift cards"));
  assert.equal(gap?.times, 2, JSON.stringify(an.gaps));
  assert.ok(an.totals.gaps >= 2 && an.totals.answers > an.totals.gaps);
  assert.ok(an.disliked.some((d) => Number(d.message_id) === r9.done.messageId && d.question === "Are returns accepted?" && d.times === 1 && !d.fixed));
  assert.equal(an.totals.thumbs_down, 1);
  ok("analytics: daily series, totals, knowledge gaps (grouped, playground excluded) and 👎 answers");

  await a.json(`/api/agents/${agentId}/fixes`, { method: "POST", body: { question: gapQ, answer: "Yes, gift cards from ₹500." } });
  const after = await chat(agentId, sid(), gapQ);
  assert.ok(after.text.includes("gift cards from ₹500"), after.text);
  assert.equal((await a.json(`/api/agents/${agentId}/analytics?days=7`)).data.totals.gaps, an.totals.gaps, "a question answered by a Q&A fix is not a gap");
  assert.equal((await b.json(`/api/agents/${agentId}/analytics`)).status, 404);
  assert.equal((await a.json(`/api/agents/${agentId}/analytics?days=12`)).status, 400);
  ok("answering a gap closes it; analytics are private and validated");

  // ---- Lead capture ---------------------------------------------------------------------------------
  const pubAgent = async () => (await fetch(`${BASE}/embed/${agentId}`)).text();
  const submitLead = (sessionId, body) => client().json(`/api/chat/${agentId}/lead`, { method: "POST", body: { sessionId, ...body } });
  assert.equal((await submitLead(sid(), { name: "X", phone: "9876543210" })).status, 403, "lead form is off by default");
  assert.equal((await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { leadFields: [] } })).status, 400);
  assert.equal(
    (await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { leadMode: "before_chat", leadFields: ["phone", "name"], leadMessage: "Tell us who you are" } })).status,
    200
  );
  assert.deepEqual((await a.json(`/api/agents/${agentId}`)).data.agent.lead_fields, ["name", "phone"]);
  assert.ok((await pubAgent()).includes("Tell us who you are"));

  const L1 = sid();
  assert.equal((await chat(agentId, L1, "hello")).status, 428, "before_chat: messages need the form first");
  assert.equal((await submitLead(L1, { name: "Ravi" })).status, 400, "phone is required");
  assert.equal((await submitLead(L1, { name: "Ravi", phone: "call me" })).status, 400);
  assert.equal((await submitLead(L1, { name: "Ravi Kumar", phone: "+91 98765-43210", email: "ignored@x.in" })).status, 200);
  assert.equal((await client().json(`/api/chat/${agentId}/messages?sessionId=${L1}&all=1`)).data.hasLead, true);
  assert.equal((await chat(agentId, L1, "How long does delivery take?")).status, 200);
  assert.equal((await chat(agentId, sid(), "hi", { channel: "playground", cookie: a.cookie() })).status, 200, "the playground is never gated");
  ok("lead form: validated fields, required before chatting when set so, remembered for the visitor");

  await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { leadMode: "after_first_answer" } });
  const L2 = sid();
  assert.equal((await chat(agentId, L2, "Are returns accepted?")).status, 200, "after_first_answer never blocks");
  await client().json(`/api/chat/${agentId}/handoff`, { method: "POST", body: { sessionId: L2, contact: "=cmd@evil.in" } });
  const L3 = sid();
  await client().json(`/api/chat/${agentId}/handoff`, { method: "POST", body: { sessionId: L3, contact: "priya@example.in" } });
  const leads = (await a.json(`/api/agents/${agentId}/leads`)).data.leads;
  const ravi = leads.find((l) => l.name === "Ravi Kumar");
  assert.ok(ravi && ravi.phone === "+919876543210" && ravi.email === null && ravi.source === "form" && ravi.first_message === "How long does delivery take?", JSON.stringify(ravi));
  assert.ok(leads.some((l) => l.email === "priya@example.in" && l.source === "handoff"));
  assert.ok(leads.some((l) => l.email === "=cmd@evil.in"), "a weird but valid e-mail is still a lead");
  ok("contact details left when asking for a person become leads");

  const csvRes = await a.req(`/api/agents/${agentId}/leads?format=csv`);
  const bytes = Buffer.from(await csvRes.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM so Excel reads Unicode");
  const csv = bytes.toString("utf8");
  assert.match(csvRes.headers.get("content-type"), /text\/csv/);
  assert.match(csvRes.headers.get("content-disposition"), /attachment; filename="leads-Feature-Bot-/);
  assert.ok(csv.startsWith("\ufeffName,E-mail,Phone,Channel,Captured via,Date,First question"), csv.slice(0, 80));
  assert.ok(csv.includes("Ravi Kumar,,+919876543210,widget,form,"));
  assert.ok(csv.includes(",'=cmd@evil.in,"), "formula-like cells are defused");
  ok("leads download as CSV (Excel-friendly, formula injection defused)");

  assert.equal((await b.json(`/api/agents/${agentId}/leads`)).status, 404);
  assert.equal((await b.json(`/api/agents/${agentId}/leads/${ravi.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await a.json(`/api/agents/${agentId}/leads/${ravi.id}`, { method: "DELETE" })).status, 200);
  assert.ok(!(await a.json(`/api/agents/${agentId}/leads`)).data.leads.some((l) => l.id === ravi.id));
  ok("leads are private to the owner and can be deleted");

  console.log(`\nAll ${passed} feature checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
}
