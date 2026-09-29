// End-to-end test of the production AI pipeline against a RUNNING server with the mock models:
// retries, timeouts, the backup model, and (later phases) usage/cost records, the admin view and search quality.
// Start the app with a short first-token timeout and a backup model, then run  pnpm smoke:ai :
//   LLM_FIRST_TOKEN_TIMEOUT_MS=2000 LLM_FALLBACK_PROVIDER=mock LLM_FALLBACK_MODEL=backup pnpm start
import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const IP = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = () => crypto.randomBytes(12).toString("hex");

export function client() {
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

async function chat(agentId, sessionId, message) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": IP },
    body: JSON.stringify({ message, sessionId, channel: "widget" }),
  });
  if (!res.ok) return { status: res.status, error: (await res.json()).error };
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return {
    status: res.status,
    ms: Date.now() - t0,
    text: events.filter((e) => e.type === "delta").map((e) => e.text).join(""),
    done: events.find((e) => e.type === "done"),
    error: events.find((e) => e.type === "error")?.message,
  };
}

try {
  console.log(`AI pipeline smoke test against ${BASE}\n`);
  const a = client();
  await a.json("/api/auth/signup", { method: "POST", body: { email: `ai${Date.now()}@example.com`, password: "password-123" } });
  const agentId = (await a.json("/api/agents", { method: "POST", body: { name: "AI Bot" } })).data.agent.id;
  await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "text", title: "FAQ", text: "Refunds: you can return any product within 7 days of delivery for a full refund." } });
  for (let i = 0; i < 50 && (await a.json(`/api/agents/${agentId}/sources`)).data.sources.some((s) => s.status === "processing"); i++) await sleep(200);
  const used = async () => (await a.json("/api/me")).data.usage.used;

  // ---- Phase 1a: timeouts, retries, backup model -----------------------------------------------------
  const r1 = await chat(agentId, sid(), "What is the refund policy? [[mock:fail-429x2]]");
  assert.ok(r1.done && r1.text.includes("7 days"), JSON.stringify(r1));
  assert.ok(!r1.text.includes("fallback"), "answered by the main model after retrying");
  ok("rate-limited model calls are retried with backoff and then answered");

  const before = await used();
  const r2 = await chat(agentId, sid(), "What is the refund policy? [[mock:fail-500]]");
  assert.ok(r2.done && r2.text.includes("(mock fallback: backup)"), JSON.stringify(r2));
  assert.equal(await used(), before + 1);
  ok("when the main model keeps failing, the backup model answers");

  const r3 = await chat(agentId, sid(), "What is the refund policy? [[mock:hang]]");
  assert.ok(r3.done && r3.text.includes("(mock fallback: backup)"), JSON.stringify(r3));
  assert.ok(r3.ms < 20_000, `a hung model must not hang the chat (${r3.ms} ms)`);
  ok(`a model that never answers times out (answered by the backup after ${(r3.ms / 1000).toFixed(1)} s)`);

  const b4 = await used();
  const r4 = await chat(agentId, sid(), "What is the refund policy? [[mock:break]]");
  assert.ok(r4.error && r4.text.length > 0 && !r4.text.includes("fallback"), JSON.stringify(r4));
  assert.equal(await used(), b4 + 1, "a partial answer was shown, so the credit is used");
  ok("a failure after text reached the visitor is not retried (no repeated or mixed answers)");

  console.log(`\nAll ${passed} AI pipeline checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
}
