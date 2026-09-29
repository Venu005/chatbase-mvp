// End-to-end test of the production AI pipeline against a RUNNING server with the mock models:
// retries, timeouts, the backup model, and (later phases) usage/cost records, the admin view and search quality.
// Start the app with a short first-token timeout and a backup model, then run  pnpm smoke:ai :
//   LLM_FIRST_TOKEN_TIMEOUT_MS=2000 LLM_FALLBACK_PROVIDER=mock LLM_FALLBACK_MODEL=backup INGEST_RETRY_BASE_MS=1000 \
//   ADMIN_EMAILS=admin@smoke.test pnpm start
//   LLM_SMALL_PROVIDER=mock LLM_SMALL_MODEL=small OCR_PROVIDER=openai OCR_MODEL=fake-vision OCR_API_KEY=ocr-test \
//   OCR_BASE_URL=http://127.0.0.1:4060/v1 'PRERENDER_URL=http://127.0.0.1:4060/render?url={url}'
// (this script runs the fake vision API and rendering service on :4060).
// Needs DATABASE_URL (from .env) for the crash-recovery check, and ALLOW_PRIVATE_URLS=true for the website checks.
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
const RUN = Date.now().toString(36); // fault-injected questions/texts must be new on every run (the mock remembers them)

// ---- fake vision API (OCR) and page-rendering service ---------------------------------------------------
const ocrCalls = [];
const fakes = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url === "/v1/chat/completions") {
      const body = JSON.parse(raw);
      ocrCalls.push({ auth: req.headers.authorization, model: body.model, part: body.messages[1].content[0] });
      res.setHeader("content-type", "application/json");
      const isPdf = body.messages[1].content[0].type === "file";
      const text = isPdf ? "Scanned menu\nMasala dosa - ₹80\nFilter coffee - ₹30" : "Photo price list\nGhee 1 litre (code GH-1L) - ₹650";
      return res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 1500, completion_tokens: 40 } }));
    }
    if (req.url.startsWith("/render?url=")) {
      res.setHeader("content-type", "text/html");
      return res.end("<html><head><title>Rendered shop</title></head><body><main><h1>Our bakery</h1><p>Fresh sourdough bread is baked every morning at 6am and costs 220 rupees a loaf.</p></main></body></html>");
    }
    res.statusCode = 404;
    res.end();
  });
});
await new Promise((r) => fakes.listen(4060, "127.0.0.1", r));

/** A one-page PDF with no text layer (like a scan). */
function scannedPdf() {
  const stream = "0 0 0 rg 50 50 100 100 re f";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => (offs.push(out.length), (out += `${i + 1} 0 obj\n${o}\nendobj\n`)));
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

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
  const r1 = await chat(agentId, sid(), `What is the refund policy? [[mock:fail-429x2]] ${RUN}`);
  assert.ok(r1.done && r1.text.includes("7 days"), JSON.stringify(r1));
  assert.ok(!r1.text.includes("(mock backup)"), "answered by the main model after retrying");
  ok("rate-limited model calls are retried with backoff and then answered");

  const before = await used();
  const r2 = await chat(agentId, sid(), "What is the refund policy? [[mock:fail-500]]");
  assert.ok(r2.done && r2.text.includes("(mock backup)"), JSON.stringify(r2));
  assert.equal(await used(), before + 1);
  ok("when the main model keeps failing, the backup model answers");

  const r3 = await chat(agentId, sid(), "What is the refund policy? [[mock:hang]]");
  assert.ok(r3.done && r3.text.includes("(mock backup)"), JSON.stringify(r3));
  assert.ok(r3.ms < 20_000, `a hung model must not hang the chat (${r3.ms} ms)`);
  ok(`a model that never answers times out (answered by the backup after ${(r3.ms / 1000).toFixed(1)} s)`);

  const b4 = await used();
  const r4 = await chat(agentId, sid(), "What is the refund policy? [[mock:break]]");
  assert.ok(r4.error && r4.text.length > 0 && !r4.text.includes("(mock backup)"), JSON.stringify(r4));
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

  const flaky = await addText("Flaky", `Shipping takes 4 days to metro cities. [[mock:embed-fail-6]] We ship everywhere. ${RUN}`);
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

  // ---- Phase 4: answer cache ----------------------------------------------------------------------------
  const cq = "What is the refund policy for returns?";
  const c1 = await chat(agentId, sid(), cq);
  const u1 = await used();
  const c2 = await chat(agentId, sid(), "  what is the REFUND policy for returns ");
  assert.equal(c2.text, c1.text, "the same first question gets the stored answer");
  assert.deepEqual(c2.done.citations, c1.done.citations);
  assert.equal(await used(), u1 + 1, "a cached answer still uses the customer's credit");
  ok("a repeated first question is answered from the cache (same answer and citations)");

  const FU = sid();
  await chat(agentId, FU, "Hello");
  const f2 = await chat(agentId, FU, cq);
  assert.ok(f2.done, "follow-ups are answered fresh");
  await a.json(`/api/agents/${agentId}/fixes`, { method: "POST", body: { question: cq, answer: "Returns: 14 days now, no questions asked." } });
  const c3 = await chat(agentId, sid(), cq);
  assert.ok(c3.text.includes("14 days now"), "a Q&A change invalidates the cache: " + c3.text);
  ok("follow-ups skip the cache, and changing the agent's knowledge (a new Q&A answer) invalidates it at once");

  // ---- Phase 4: routing to a small model ----------------------------------------------------------------
  const an0 = (await a.json(`/api/agents/${agentId}/analytics?days=7`)).data.totals.gaps;
  const thanks = await chat(agentId, sid(), "Thanks a lot!");
  assert.ok(thanks.done && thanks.text.startsWith("(mock small)"), thanks.text);
  assert.equal((await a.json(`/api/agents/${agentId}/analytics?days=7`)).data.totals.gaps, an0, "small talk is not a knowledge gap");
  const normal = (await chat(agentId, sid(), "Do you ship to metro cities quickly?")).text; // no close Q&A match: main model
  assert.ok(normal.startsWith("(mock model)"), normal);
  const exact = await chat(agentId, FU, cq); // a follow-up turn (no cache) that exactly matches a Q&A answer
  assert.ok(exact.text.startsWith("(mock small)") && exact.text.includes("14 days now"), exact.text);
  ok("small talk skips search and isn't a knowledge gap; small talk and close Q&A matches are answered by the small model");

  // ---- Phase 4: scanned PDFs, photos and JavaScript-built websites --------------------------------------
  const upload = async (name, bytes, type) => {
    const fd = new FormData();
    fd.set("file", new Blob([bytes], { type }), name);
    const res = await fetch(`${BASE}/api/agents/${agentId}/sources`, { method: "POST", headers: { cookie: a.cookie(), "x-forwarded-for": IP }, body: fd });
    return { status: res.status, data: await res.json() };
  };
  const scan = await upload("menu-scan.pdf", scannedPdf(), "application/pdf");
  assert.equal(scan.status, 202);
  const photo = await upload("prices.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "image/jpeg");
  assert.equal(photo.status, 202, JSON.stringify(photo.data));
  const s1 = await waitFor(scan.data.source.id, (s) => s.status !== "processing");
  const s2 = await waitFor(photo.data.source.id, (s) => s.status !== "processing");
  assert.equal(s1.status, "ready", JSON.stringify(s1));
  assert.equal(s2.status, "ready", JSON.stringify(s2));
  assert.equal(ocrCalls.length, 2);
  assert.equal(ocrCalls[0].auth, "Bearer ocr-test");
  assert.ok(ocrCalls.some((c) => c.part.type === "file" && c.part.file.file_data.startsWith("data:application/pdf;base64,")));
  assert.ok(ocrCalls.some((c) => c.part.type === "image_url" && c.part.image_url.url.startsWith("data:image/jpeg;base64,")));
  assert.ok((await chat(agentId, sid(), "masala dosa price")).text.includes("₹80"));
  assert.ok((await chat(agentId, sid(), "price of GH-1L?")).text.includes("₹650"));
  ok("scanned PDFs (no text layer) and photos are read by the vision model (OCR) and become searchable");

  const jsSite = http
    .createServer((_q, res) => (res.setHeader("content-type", "text/html"), res.end('<html><body><div id="root"></div><script src="/app.js"></script></body></html>')))
    .listen(0);
  const js = await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "url", url: `http://127.0.0.1:${jsSite.address().port}/` } });
  const jsDone = await waitFor(js.data.source.id, (s) => s.status !== "processing");
  jsSite.close();
  assert.equal(jsDone.status, "ready", JSON.stringify(jsDone));
  assert.ok((await chat(agentId, sid(), "sourdough bread price")).text.includes("220 rupees"));
  ok("a website that builds its pages with JavaScript is read through the rendering service");

  // ---- Admin view ---------------------------------------------------------------------------------------
  assert.equal((await a.json("/api/admin/overview")).status, 404, "non-admins don't see the admin API");
  assert.equal((await a.req("/admin")).status, 404, "or the page");
  const admin = client();
  const creds = { email: "admin@smoke.test", password: "admin-password-1" };
  if ((await admin.json("/api/auth/signup", { method: "POST", body: creds })).status === 409) await admin.json("/api/auth/login", { method: "POST", body: creds });
  assert.equal((await admin.req("/admin")).status, 200);

  const ov = (await admin.json("/api/admin/overview?days=1")).data;
  const me = (await a.json("/api/me")).data.user;
  const mine = ov.accounts.find((x) => x.id === me.id);
  assert.ok(mine && mine.answers >= 4 && mine.errors === 0, JSON.stringify(mine));
  assert.ok(mine.credits_used >= 4 && mine.credits_limit === 50);
  assert.ok(ov.totals.answers >= 4 && ov.totals.fallbacks >= 2 && ov.totals.partial >= 1, JSON.stringify(ov.totals));
  assert.equal(ov.series.length, 1);
  assert.ok(ov.models.some((m) => m.model === "backup" && m.kind === "answer"));
  assert.equal(ov.config.fallback, "mock:backup");
  const prob = ov.problems.find((p) => p.question?.includes("[[mock:fail-500]]"));
  assert.ok(prob && prob.fallback_used && /Mock failure \(500\)/.test(prob.error), JSON.stringify(prob));
  ok("admin overview: totals, accounts with credits, models, and a problems feed (backup-model answers, cut-offs)");

  const retried = ov.problems.find((p) => p.question?.includes("[[mock:fail-429x2]]"));
  const trace = (await admin.json(`/api/admin/calls/${retried.id}`)).data;
  assert.equal(trace.call.attempts, 3);
  assert.equal(trace.call.status, "ok");
  assert.ok(trace.answer.includes("7 days"));
  assert.ok(trace.retrieved.length >= 1 && trace.retrieved[0].content.includes("7 days") && trace.retrieved[0].score > 0, JSON.stringify(trace.retrieved));
  assert.equal(trace.call.prompt_version, "2026-09-29.1");
  const detail = (await admin.json(`/api/admin/accounts/${me.id}?days=1`)).data;
  assert.ok(detail.calls.some((x) => x.question?.includes("REFUND policy") && x.model !== "mock"), "cache hits are recorded (model = cached model)");
  assert.ok(ov.models.some((m) => m.provider === "cache" && m.calls >= 1 && m.cost_usd === 0), JSON.stringify(ov.models));
  assert.ok(detail.agents.some((x) => x.name === "AI Bot" && x.answers >= 4 && x.sources >= 4));
  assert.ok(detail.calls.some((x) => x.kind === "ingest"));
  assert.equal((await a.json(`/api/admin/calls/${retried.id}`)).status, 404);
  ok("answer trace shows the question, answer, retries and the exact passages (with scores); account drill-down works");

  const FS = sid();
  await chat(agentId, FS, "What is the refund policy?");
  await chat(agentId, FS, "and for opened items?");
  const followTrace = (await admin.json("/api/admin/overview?days=1")).data; // make sure the call is recorded first
  const detail2 = (await admin.json(`/api/admin/accounts/${me.id}?days=1`)).data;
  const fc = detail2.calls.find((x) => x.question === "and for opened items?");
  const ft = (await admin.json(`/api/admin/calls/${fc.id}`)).data;
  assert.ok(ft.call.search_query?.includes("What is the refund policy?") && ft.call.search_query.includes("and for opened items?"), JSON.stringify(ft.call.search_query));
  assert.ok(ft.retrieved.every((r) => ["vector", "keyword", "both"].includes(r.via)), JSON.stringify(ft.retrieved));
  assert.ok(followTrace.totals.answers > 0);
  ok("follow-up questions are searched with their context, and the trace shows what was searched and by which search");

  // Simulate an embedding model change: passages made by "old:model" aren't searched until re-indexed.
  const db2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db2.connect();
  await db2.query("UPDATE chunks SET embedding_model = 'old:model' WHERE source_id = $1", [crashed]);
  const staleAnswer = await chat(agentId, sid(), "Is gift wrapping free?");
  assert.ok(!staleAnswer.text.includes("Gift wrapping is free"), "vectors from another model are not compared");
  assert.ok((await admin.json("/api/admin/overview")).data.embedding.stale >= 1);
  const re = (await admin.json("/api/admin/reindex", { method: "POST", body: {} })).data;
  assert.ok(re.sourcesQueued >= 1, JSON.stringify(re));
  await waitFor(crashed, (s) => s.status === "ready");
  const after = (await db2.query("SELECT DISTINCT embedding_model FROM chunks WHERE source_id = $1", [crashed])).rows.map((r) => r.embedding_model);
  await db2.end();
  assert.deepEqual(after, ["mock:mock-embed"]);
  assert.ok((await chat(agentId, sid(), "Is gift wrapping free?")).text.includes("Gift wrapping is free"));
  ok("after an embedding model change, old passages are ignored until the admin re-indexes them");

  console.log(`\nAll ${passed} AI pipeline checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
} finally {
  fakes.close();
}
