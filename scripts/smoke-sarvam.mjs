// Tests the Sarvam LLM provider end to end against a local FAKE Sarvam API. It starts its own copy of the built app
// (pnpm build first) on port 3010 with LLM_PROVIDER=sarvam, so it does not need a running server:  pnpm smoke:sarvam
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 3010;
const BASE = `http://localhost:${PORT}`;
const FAKE_PORT = Number(process.env.FAKE_SARVAM_PORT ?? 4040);
const KEY = "sk_test_sarvam_key";
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = () => crypto.randomBytes(12).toString("hex");

// ---- fake Sarvam API ------------------------------------------------------------------------------------
const requests = [];
let mode = "ok";
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return (res.statusCode = 404), res.end("{}");
    if (req.headers["api-subscription-key"] !== KEY) return (res.statusCode = 403), res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    requests.push(JSON.parse(body));
    if (mode === "fail") return (res.statusCode = 500), res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frames = ["<thi", "nk>reasoning about opening hours</thi", "nk>\n\nदुकान सुबह 8 बजे खुलती है। ", "Sharma Kirana is open 8am to 10pm. [1]"];
    frames.forEach((c, i) => res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: c } : { content: c } }] })}\n\n`));
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", r));

// ---- start the app with the Sarvam provider ---------------------------------------------------------------------
const app = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  env: {
    ...process.env,
    PORT: String(PORT),
    LLM_PROVIDER: "sarvam",
    SARVAM_API_KEY: KEY,
    SARVAM_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`,
    SARVAM_REASONING_EFFORT: "none",
    LLM_MODEL: "",
    EMBEDDING_PROVIDER: "mock",
    APP_URL: BASE,
    SIGNUP_RATE_LIMIT: "1000",
    SMTP_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));
const cleanup = () => {
  app.kill("SIGTERM");
  fake.close();
};

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
async function chat(agentId, sessionId, message) {
  const res = await fetch(`${BASE}/api/chat/${agentId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, sessionId }) });
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { events, answer: events.filter((e) => e.type === "delta").map((e) => e.text).join(""), error: events.find((e) => e.type === "error") };
}

try {
  console.log(`Sarvam provider smoke test (fake Sarvam API on :${FAKE_PORT}, app on :${PORT})`);
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${BASE}/login`).then((r) => r.ok).catch(() => false)) break;
    await sleep(500);
    if (i === 59) throw new Error("app did not start:\n" + appLog);
  }
  const a = client();
  await a.json("/api/auth/signup", { method: "POST", body: { email: `sarvam${Date.now()}@example.com`, password: "correct-horse-battery" } });
  const agentId = (await a.json("/api/agents", { method: "POST", body: { name: "Kirana Bot" } })).data.agent.id;
  await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "text", title: "Store", text: "Sharma Kirana is open from 8am to 10pm every day." } });
  for (let i = 0; i < 40; i++) {
    if ((await a.json(`/api/agents/${agentId}/sources`)).data.sources.every((s) => s.status === "ready")) break;
    await sleep(250);
  }
  const used = async () => (await a.json("/api/me")).data.usage.used;

  const S = sid();
  const r = await chat(agentId, S, "When is the shop open?");
  assert.equal(r.error, undefined, JSON.stringify(r.events));
  assert.equal(r.answer, "दुकान सुबह 8 बजे खुलती है। Sharma Kirana is open 8am to 10pm. [1]");
  assert.ok(!r.answer.includes("think") && !r.answer.includes("reasoning"));
  ok("answers stream through the Sarvam provider, and <think> reasoning (even split across chunks) never reaches the customer");

  const req = requests.at(-1);
  assert.equal(req.model, "sarvam-105b");
  assert.equal(req.stream, true);
  assert.equal(req.reasoning_effort, null);
  assert.ok(req.max_tokens > 0);
  assert.equal(req.messages[0].role, "system");
  assert.ok(req.messages[0].content.includes("<context>") && req.messages[0].content.includes("8am to 10pm"));
  assert.deepEqual(req.messages.slice(1), [{ role: "user", content: "When is the shop open?" }]);
  ok("request shape: api-subscription-key header, default model sarvam-105b, streaming, reasoning off, grounded system prompt");
  assert.equal(await used(), 1);

  // Consecutive same-role turns (possible after a human handoff) are merged so the API's alternation rules hold.
  const S2 = sid();
  await chat(agentId, S2, "I want to talk to a human");
  await chat(agentId, S2, "hello?");
  await chat(agentId, S2, "anyone there?");
  const cid = (await a.json(`/api/agents/${agentId}/conversations`)).data.conversations.find((c) => c.first_message === "I want to talk to a human").id;
  await a.json(`/api/agents/${agentId}/conversations/${cid}`, { method: "PATCH", body: { mode: "bot" } });
  const n0 = requests.length;
  const r2 = await chat(agentId, S2, "When is the shop open?");
  assert.equal(r2.error, undefined);
  const hist = requests[n0].messages.slice(1);
  assert.equal(hist[0].role, "user");
  hist.forEach((m, i) => i && assert.notEqual(m.role, hist[i - 1].role, "roles must alternate"));
  assert.ok(hist.some((m) => m.content.includes("hello?") && m.content.includes("anyone there?")), JSON.stringify(hist));
  ok("after a human handoff the history is normalised (merged same-role turns) before it reaches Sarvam");

  // Upstream failure: friendly error, credit refunded
  mode = "fail";
  const before = await used();
  const bad = await chat(agentId, sid(), "When is the shop open?");
  assert.ok(bad.error && !bad.error.message.includes("exploded"), "internal error details must not leak to visitors");
  assert.equal(bad.answer, "");
  assert.equal(await used(), before, "the credit is refunded when the model call fails");
  ok("if Sarvam fails the visitor gets a friendly error (no internals leaked) and the credit is refunded");
  mode = "ok";

  console.log(`\nAll ${passed} Sarvam provider checks passed.`);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exitCode = 1;
} finally {
  cleanup();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
