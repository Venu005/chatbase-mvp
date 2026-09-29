// End-to-end test of the production AI pipeline against a RUNNING server with the mock models:
// retries, timeouts, the backup model, and (later phases) usage/cost records, the admin view and search quality.
// Start the app with a short first-token timeout and a backup model, then run  pnpm smoke:ai :
//   LLM_FIRST_TOKEN_TIMEOUT_MS=2000 LLM_FALLBACK_PROVIDER=mock LLM_FALLBACK_MODEL=backup INGEST_RETRY_BASE_MS=1000 pnpm start
// Needs DATABASE_URL (from .env) for the crash-recovery check, and ALLOW_PRIVATE_URLS=true for the website check.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";

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

  // ---- Phase 1c: durable ingestion queue ---------------------------------------------------------------
  const sources = async () => (await a.json(`/api/agents/${agentId}/sources`)).data.sources;
  const waitFor = async (id, pred, ms = 40_000) => {
    const seen = [];
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) {
      const s = (await sources()).find((x) => x.id === id);
      if (s?.error) seen.push(s.error);
      if (s && pred(s)) return { ...s, seen };
    }
    throw new Error(`timed out waiting for source ${id}`);
  };
  const addText = async (title, text) => (await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "text", title, text } })).data.source.id;

  const flaky = await addText("Flaky", "Shipping takes 4 days to metro cities. [[mock:embed-fail-6]] We ship everywhere.");
  const f = await waitFor(flaky, (s) => s.status !== "processing");
  assert.equal(f.status, "ready", JSON.stringify(f));
  assert.ok(f.seen.some((e) => /Retrying \(attempt 1 of 3 failed\)/.test(e)), JSON.stringify(f.seen));
  ok("a temporary embedding outage is retried by the queue (with backoff) until the source is ready");

  const site = http.createServer((_q, res) => ((res.statusCode = 404), res.end("nope"))).listen(0);
  const port = site.address().port;
  const web = (await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "url", url: `http://127.0.0.1:${port}/gone` } })).data.source.id;
  const w = await waitFor(web, (s) => s.status !== "processing");
  site.close();
  assert.equal(w.status, "failed");
  assert.match(w.error, /HTTP 404/);
  assert.ok(!w.seen.some((e) => /Retrying/.test(e)), "a 404 is permanent: no retries");
  ok("a permanent failure (website 404) fails at once, without retries");

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const crashed = (
    await db.query(
      `INSERT INTO sources (agent_id, type, title, status, attempts, locked_until, run_after) VALUES ($1, 'text', 'Crashed', 'processing', 1, now() - interval '1 minute', now() - interval '20 minutes') RETURNING id`,
      [agentId]
    )
  ).rows[0].id;
  await db.query("INSERT INTO source_payloads (source_id, docs) VALUES ($1, $2)", [crashed, JSON.stringify([{ title: "Crashed", url: null, text: "Gift wrapping is free on orders above Rs 999." }])]);
  const c = await waitFor(crashed, (s) => s.status !== "processing");
  assert.equal(c.status, "ready");
  const models = (await db.query("SELECT DISTINCT embedding_model FROM chunks WHERE source_id = $1", [crashed])).rows.map((r) => r.embedding_model);
  assert.deepEqual(models, ["mock:mock-embed"]);
  await db.end();
  ok("a job whose server crashed mid-way is picked up again when its lease expires; passages record their embedding model");

  const doomed = await addText("Doomed", "Warranty is two years on all wallets. [[mock:embed-fail-99]]");
  const d = await waitFor(doomed, (s) => s.status !== "processing", 60_000);
  assert.equal(d.status, "failed");
  assert.equal(d.retryable, true, "pasted text is kept, so it can be retried");
  const retry = await a.json(`/api/agents/${agentId}/sources/${doomed}`, { method: "POST" });
  assert.equal(retry.status, 202);
  assert.equal((await sources()).find((x) => x.id === doomed).status, "processing");
  ok("after the last attempt a source fails; text and file sources can now be retried too");

  console.log(`\nAll ${passed} AI pipeline checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
}
