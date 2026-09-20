// End-to-end smoke test against a RUNNING server (pnpm build && pnpm start).
//   BASE_URL=http://localhost:3000 pnpm smoke
// Uses only HTTP, so it works with the mock providers (no API keys needed).
import http from "node:http";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;

// ---- tiny cookie-jar client -------------------------------------------------
function client() {
  let cookie = "";
  return {
    async req(path, { method = "GET", body, form, headers = {} } = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: form ?? (body ? JSON.stringify(body) : undefined),
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

async function chat(agentId, message, sessionId, ip = "10.0.0.1") {
  const res = await fetch(`${BASE}/api/chat/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ message, sessionId, channel: "playground" }),
  });
  if (!res.ok) return { status: res.status, error: (await res.json()).error };
  let text = "", citations = [], done = false, errorEvent = null;
  for (const l of (await res.text()).split("\n").filter(Boolean)) {
    const ev = JSON.parse(l);
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "done") (done = true), (citations = ev.citations);
    if (ev.type === "error") errorEvent = ev.message;
  }
  return { status: res.status, text, citations, done, errorEvent };
}

async function waitReady(c, agentId, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await c.json(`/api/agents/${agentId}/sources`);
    if (!data.sources.some((s) => s.status === "processing")) return data.sources;
    if (Date.now() - t0 > timeoutMs) throw new Error("ingestion timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
}

function makePdf(text) {
  const esc = text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 12 Tf 50 700 Td (${esc}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => (offs.push(out.length), (out += `${i + 1} 0 obj\n${o}\nendobj\n`)));
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

// ---- a tiny fake business website to crawl ---------------------------------
const site = http.createServer((req, res) => {
  const page = (title, body) =>
    `<html><head><title>${title}</title><script>var secret="TRACKING_JUNK"</script></head><body><nav><a href="/">Home</a> <a href="/shipping">Shipping</a> <a href="/about">About</a></nav><main>${body}</main><footer>FOOTER_JUNK</footer></body></html>`;
  res.setHeader("content-type", "text/html");
  if (req.url === "/shipping") res.end(page("Shipping", "<h1>Shipping</h1><p>We deliver across India within 3 to 5 working days. Free delivery on orders above 999 rupees.</p>"));
  else if (req.url === "/about") res.end(page("About us", "<h1>About</h1><p>Founded in Pune in 2019, we make handmade leather wallets.</p>"));
  else res.end(page("Home", "<h1>Welcome</h1><p>Handmade leather goods from Pune.</p>"));
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${site.address().port}`;

try {
  console.log(`Smoke test against ${BASE}`);

  // ---- auth ----------------------------------------------------------------
  const a = client();
  const email = `smoke${Date.now()}@example.com`;
  assert.equal((await a.json("/api/me")).status, 401);
  ok("unauthenticated requests are rejected");
  assert.equal((await a.json("/api/auth/signup", { method: "POST", body: { email, password: "short" } })).status, 400);
  ok("weak password rejected");
  assert.equal((await a.json("/api/auth/signup", { method: "POST", body: { email, password: "correct-horse-battery" } })).status, 200);
  const me = await a.json("/api/me");
  assert.equal(me.data.user.email, email);
  assert.equal(me.data.usage.limit, 50);
  ok("signup + session cookie + usage");
  assert.equal((await client().json("/api/auth/login", { method: "POST", body: { email, password: "wrong-password" } })).status, 401);
  ok("wrong password rejected");

  // ---- agent + sources ------------------------------------------------------
  const created = await a.json("/api/agents", { method: "POST", body: { name: "Wallet Shop Bot", instructions: "Be friendly." } });
  assert.equal(created.status, 201);
  const agentId = created.data.agent.id;
  assert.equal((await a.json("/api/agents", { method: "POST", body: { name: "Second" } })).status, 402);
  ok("agent created; free plan agent limit enforced");

  const faq =
    "Refund policy: You can return any product within 7 days of delivery for a full refund. Refunds are credited to the original payment method within 5 business days.\n\n" +
    "Payment options: We accept UPI, credit cards, debit cards and cash on delivery.";
  assert.equal((await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "text", title: "FAQ", text: faq } })).status, 202);

  const hindi = "वापसी नीति: आप डिलीवरी के 7 दिनों के भीतर कोई भी सामान वापस कर सकते हैं। पैसे 5 कार्यदिवसों में वापस मिल जाएंगे।";
  await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "text", title: "हिंदी FAQ", text: hindi } });

  const fd = new FormData();
  fd.set("file", new Blob(["Our store timings are 10am to 8pm, Monday to Saturday. We are closed on Sundays."], { type: "text/plain" }), "timings.txt");
  assert.equal((await a.req(`/api/agents/${agentId}/sources`, { method: "POST", form: fd })).status, 202);

  const pdf = new FormData();
  pdf.set("file", new Blob([makePdf("Warranty: every wallet carries a two year warranty against stitching defects.")], { type: "application/pdf" }), "warranty.pdf");
  assert.equal((await a.req(`/api/agents/${agentId}/sources`, { method: "POST", form: pdf })).status, 202);

  const bad = new FormData();
  bad.set("file", new Blob(["x"]), "malware.exe");
  assert.equal((await a.req(`/api/agents/${agentId}/sources`, { method: "POST", form: bad })).status, 400);
  ok("text, Hindi text, .txt and .pdf sources accepted; .exe rejected");

  let sources = await waitReady(a, agentId);
  for (const s of sources) assert.equal(s.status, "ready", `${s.title}: ${s.status} ${s.error ?? ""}`);
  assert.equal(sources.length, 4);
  ok("all sources ingested (chunked + embedded + stored in pgvector)");

  // ---- RAG chat -------------------------------------------------------------
  const r1 = await chat(agentId, "What is your refund policy?", "session-aaaaaaaa1");
  assert.ok(r1.done && r1.text.includes("7 days"), r1.text);
  assert.ok(r1.citations.length >= 1);
  ok(`grounded answer with citation → "${r1.text.slice(0, 70)}…"`);

  const r2 = await chat(agentId, "वापसी नीति क्या है?", "session-aaaaaaaa2");
  assert.ok(r2.text.includes("7 दिनों"), r2.text);
  ok("Hindi question retrieves the Hindi source");

  const r3 = await chat(agentId, "How long is the wallet warranty?", "session-aaaaaaaa3");
  assert.ok(r3.text.includes("two year"), r3.text);
  ok("answers from an uploaded PDF");

  const r4 = await chat(agentId, "Explain quantum chromodynamics lattice simulations", "session-aaaaaaaa4");
  assert.ok(r4.text.includes("don't have information"), r4.text);
  assert.equal(r4.citations.length, 0);
  ok("out-of-scope question is not answered from sources");

  // ---- website crawl (or SSRF block if the server forbids private URLs) -----
  const urlRes = await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "url", url: SITE + "/", crawlPages: 5 } });
  if (urlRes.status === 400) {
    assert.match(urlRes.data.error, /not allowed/);
    ok("SSRF guard blocks private/localhost URLs");
  } else {
    assert.equal(urlRes.status, 202);
    sources = await waitReady(a, agentId);
    const web = sources.find((s) => s.type === "url");
    assert.equal(web.status, "ready", web.error);
    assert.ok(web.chunk_count >= 3, `expected 3 crawled pages, got ${web.chunk_count} chunks`);
    const r5 = await chat(agentId, "How many days does delivery across India take?", "session-aaaaaaaa5");
    assert.ok(r5.text.includes("3 to 5 working days"), r5.text);
    assert.ok(!r5.text.includes("TRACKING_JUNK") && !r5.text.includes("FOOTER_JUNK"));
    assert.ok(r5.citations.some((c) => c.url?.endsWith("/shipping")), JSON.stringify(r5.citations));
    ok("crawled 3 pages; scripts/nav/footer stripped; citation links to the page");
  }

  // ---- conversations + memory -----------------------------------------------
  const convos = await a.json(`/api/agents/${agentId}/conversations`);
  assert.ok(convos.data.conversations.length >= 4);
  const msgs = await a.json(`/api/agents/${agentId}/conversations/${convos.data.conversations[0].id}`);
  assert.ok(msgs.data.messages.some((m) => m.role === "assistant"));
  ok("conversations are logged and viewable by the owner");

  // ---- multi-tenant isolation -----------------------------------------------
  const b = client();
  await b.json("/api/auth/signup", { method: "POST", body: { email: `other${Date.now()}@example.com`, password: "another-password-1" } });
  assert.equal((await b.json(`/api/agents/${agentId}`)).status, 404);
  assert.equal((await b.json(`/api/agents/${agentId}/sources`)).status, 404);
  assert.equal((await b.json(`/api/agents/${agentId}/conversations`)).status, 404);
  assert.equal((await b.json(`/api/agents/${agentId}/sources/${sources[0].id}`, { method: "DELETE" })).status, 404);
  ok("another account cannot read or modify this agent");

  // ---- widget surface -----------------------------------------------------------
  const pub = await client().json(`/api/public/agents/${agentId}`);
  assert.equal(pub.data.name, "Wallet Shop Bot");
  assert.ok(!("instructions" in pub.data), "public config must not leak instructions");
  const embed = await fetch(`${BASE}/embed/${agentId}`);
  assert.equal(embed.status, 200);
  assert.match(embed.headers.get("content-security-policy") ?? "", /frame-ancestors \*/);
  assert.equal((await fetch(`${BASE}/widget.js`)).status, 200);
  assert.equal((await fetch(`${BASE}/embed/not-a-real-id`)).status, 404);
  const dash = await fetch(`${BASE}/login`);
  assert.match(dash.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  ok("widget.js, embed page (frameable) and public config work; dashboard is not frameable");

  // ---- deleting a source removes its knowledge ---------------------------------
  const faqSource = sources.find((s) => s.title === "FAQ");
  assert.equal((await a.json(`/api/agents/${agentId}/sources/${faqSource.id}`, { method: "DELETE" })).status, 200);
  const r6 = await chat(agentId, "What is your refund policy?", "session-aaaaaaaa6");
  assert.ok(!r6.text.includes("credited to the original payment method"), r6.text);
  ok("deleting a source removes it from answers");

  // ---- abuse controls -------------------------------------------------------------
  const statuses = [];
  for (let i = 0; i < 25; i++) statuses.push((await chat(agentId, "hello there", "session-aaaaaaaa7", "10.9.9.9")).status);
  assert.ok(statuses.includes(429), "rate limit should trigger");
  ok("per-IP chat rate limit triggers (429)");

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message);
  process.exitCode = 1;
} finally {
  site.close();
}
