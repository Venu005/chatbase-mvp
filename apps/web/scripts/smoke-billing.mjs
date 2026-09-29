// End-to-end test of Razorpay billing against a RUNNING server, using a local FAKE Razorpay API and signed webhooks.
//   RAZORPAY_API_BASE=http://127.0.0.1:4030 RAZORPAY_KEY_ID=rzp_test_fake RAZORPAY_KEY_SECRET=fake_key_secret \
//   RAZORPAY_WEBHOOK_SECRET=whsec_test RAZORPAY_PLAN_STARTER=plan_starter0000001 RAZORPAY_PLAN_GROWTH=plan_growth00000001 \
//   pnpm start          # (no PRO plan id on purpose)
//   pnpm smoke:billing
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PORT = Number(process.env.FAKE_RAZORPAY_PORT ?? 4030);
const KEY_ID = "rzp_test_fake", KEY_SECRET = "fake_key_secret", WH_SECRET = "whsec_test";
const PLAN = { starter: "plan_starter0000001", growth: "plan_growth00000001" };
const RUN = Date.now().toString(36);
let passed = 0, evtN = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const hmac = (secret, s) => crypto.createHmac("sha256", secret).update(s).digest("hex");

// ---- fake Razorpay API ---------------------------------------------------------------
const calls = [];
const plans = [];
let subN = 0;
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    const auth = Buffer.from((req.headers.authorization ?? "").replace("Basic ", ""), "base64").toString();
    if (auth !== `${KEY_ID}:${KEY_SECRET}`) return (res.statusCode = 401), res.end(JSON.stringify({ error: { description: "Authentication failed" } }));
    const j = body ? JSON.parse(body) : {};
    calls.push({ method: req.method, url: req.url, body: j });
    if (req.method === "POST" && req.url === "/v1/subscriptions") {
      if (!Object.values(PLAN).includes(j.plan_id)) return (res.statusCode = 400), res.end(JSON.stringify({ error: { description: "The id provided does not exist" } }));
      return res.end(JSON.stringify({ id: `sub_${RUN}${++subN}`, plan_id: j.plan_id, status: "created", short_url: "https://rzp.io/x" }));
    }
    const cancel = req.url.match(/^\/v1\/subscriptions\/(sub_\w+)\/cancel$/);
    if (req.method === "POST" && cancel) return res.end(JSON.stringify({ id: cancel[1], status: j.cancel_at_cycle_end ? "active" : "cancelled" }));
    if (req.method === "GET" && req.url.startsWith("/v1/plans")) return res.end(JSON.stringify({ items: plans }));
    if (req.method === "POST" && req.url === "/v1/plans") {
      const p = { id: `plan_new${plans.length + 1}`.padEnd(19, "0"), ...j };
      plans.push(p);
      return res.end(JSON.stringify(p));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => api.listen(PORT, "127.0.0.1", r));

// ---- helpers --------------------------------------------------------------------------------
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
async function newUser(tag) {
  const c = client();
  await c.json("/api/auth/signup", { method: "POST", body: { email: `${tag}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`, password: "correct-horse-battery" } });
  return c;
}
const planOf = async (c) => (await c.json("/api/billing")).data.plan.id;

/** Sends a signed Razorpay webhook. */
async function webhook(event, sub, { plan = sub.planId, secret = WH_SECRET, sign = true, eventId = `evt_${RUN}_${++evtN}`, currentEnd = Math.floor(Date.now() / 1000) + 30 * 86400 } = {}) {
  const raw = JSON.stringify({ entity: "event", event, payload: { subscription: { entity: { id: sub.id, plan_id: plan, status: event.split(".")[1], current_end: currentEnd } } } });
  const headers = { "content-type": "application/json", "x-razorpay-event-id": eventId };
  if (sign) headers["x-razorpay-signature"] = hmac(secret, raw);
  const res = await fetch(`${BASE}/api/razorpay/webhook`, { method: "POST", headers, body: raw });
  return { status: res.status, data: await res.json().catch(() => ({})), eventId, raw };
}
async function checkout(c, plan) {
  const r = await c.json("/api/billing/checkout", { method: "POST", body: { plan } });
  return { ...r, sub: { id: r.data.subscriptionId, planId: PLAN[plan] } };
}

try {
  console.log(`Billing smoke test against ${BASE} (fake Razorpay API on :${PORT})`);

  // ---- catalogue & checkout -------------------------------------------------------------------
  assert.equal((await client().json("/api/billing")).status, 401);
  const a = await newUser("bill");
  const cat = (await a.json("/api/billing")).data;
  assert.equal(cat.configured, true);
  assert.equal(cat.plan.id, "free");
  assert.deepEqual(Object.fromEntries(cat.plans.map((p) => [p.id, p.available])), { free: true, starter: true, growth: true, pro: false });
  ok("billing catalogue: free plan by default; a plan without a Razorpay plan id is unavailable");

  assert.equal((await a.json("/api/billing/checkout", { method: "POST", body: { plan: "pro" } })).status, 503);
  assert.equal((await a.json("/api/billing/checkout", { method: "POST", body: { plan: "enterprise" } })).status, 400);
  assert.equal((await a.json("/api/billing/checkout", { method: "POST", body: { plan: "free" } })).status, 400);
  const co = await checkout(a, "starter");
  assert.equal(co.status, 200, JSON.stringify(co.data));
  assert.equal(co.data.keyId, KEY_ID);
  const created = calls.find((c) => c.url === "/v1/subscriptions");
  assert.equal(created.body.plan_id, PLAN.starter);
  assert.equal(created.body.total_count, 120);
  assert.ok(created.body.notes.user_id && created.body.notes.plan === "starter");
  ok("checkout creates a Razorpay subscription for OUR plan id (the client can't choose the price)");

  // ---- checkout signature ------------------------------------------------------------------------
  const pay = `pay_${RUN}1`;
  const verify = (c, sig, subId = co.sub.id) => c.json("/api/billing/verify", { method: "POST", body: { razorpay_payment_id: pay, razorpay_subscription_id: subId, razorpay_signature: sig } });
  assert.equal((await verify(a, "0".repeat(64))).status, 400);
  const other = await newUser("other");
  assert.equal((await verify(other, hmac(KEY_SECRET, `${pay}|${co.sub.id}`))).status, 404);
  assert.equal((await verify(a, hmac(KEY_SECRET, `${pay}|${co.sub.id}`))).status, 200);
  assert.equal(await planOf(a), "free", "a verified checkout alone must not grant the plan");
  ok("checkout signature is verified (bad → 400, someone else's subscription → 404) but does NOT upgrade the plan");

  // ---- webhooks: security --------------------------------------------------------------------------
  assert.equal((await webhook("subscription.activated", co.sub, { sign: false })).status, 401);
  assert.equal((await webhook("subscription.activated", co.sub, { secret: "wrong" })).status, 401);
  const forged = await fetch(`${BASE}/api/razorpay/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": hmac(WH_SECRET, '{"event":"x"}'), "x-razorpay-event-id": "evt_forged" },
    body: JSON.stringify({ event: "subscription.activated", payload: { subscription: { entity: { id: co.sub.id, plan_id: co.sub.planId } } } }),
  });
  assert.equal(forged.status, 401);
  assert.equal(await planOf(a), "free");
  ok("unsigned, wrongly-signed and body-tampered webhooks are rejected; plan unchanged");

  // ---- webhooks: happy path ---------------------------------------------------------------------------
  const act = await webhook("subscription.activated", co.sub);
  assert.equal(act.status, 200);
  assert.equal(await planOf(a), "starter");
  const b1 = (await a.json("/api/billing")).data;
  assert.equal(b1.usage.limit, 1000);
  assert.equal(b1.subscription.status, "active");
  assert.ok(new Date(b1.subscription.currentEnd) > new Date());
  ok("signed 'activated' webhook upgrades the plan (1,000 credits) and records the billing period");

  const dup = await fetch(`${BASE}/api/razorpay/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-event-id": act.eventId, "x-razorpay-signature": hmac(WH_SECRET, act.raw) }, body: act.raw });
  assert.equal((await dup.json()).duplicate, true);
  ok("re-delivered webhook (same event id) is recognised as a duplicate");

  assert.equal((await a.json("/api/agents", { method: "POST", body: { name: "First" } })).status, 201);
  assert.equal((await a.json("/api/agents", { method: "POST", body: { name: "Second" } })).status, 201);
  ok("the new plan's entitlements apply immediately (free allows 1 agent, starter allows 3)");

  assert.equal((await a.json("/api/billing/checkout", { method: "POST", body: { plan: "growth" } })).status, 409);
  ok("can't start a second subscription while one is active");

  // ---- cancel ---------------------------------------------------------------------------------------------
  assert.equal((await a.json("/api/billing/cancel", { method: "POST" })).data.cancelAtPeriodEnd, true);
  const cancelCall = calls.find((c) => c.url.endsWith("/cancel"));
  assert.equal(cancelCall.body.cancel_at_cycle_end, true);
  const b2 = (await a.json("/api/billing")).data;
  assert.ok(b2.subscription.cancelAtPeriodEnd && b2.plan.id === "starter");
  ok("cancel keeps the paid plan until the period ends (cancel_at_cycle_end)");

  await webhook("subscription.charged", co.sub);
  assert.equal(await planOf(a), "starter");
  await webhook("subscription.cancelled", co.sub);
  assert.equal(await planOf(a), "free");
  await webhook("subscription.charged", co.sub); // late/out-of-order delivery after the end
  assert.equal(await planOf(a), "free");
  assert.equal((await a.json("/api/billing")).data.subscription, null);
  ok("period end ('cancelled') downgrades to Free; a late 'charged' cannot resurrect it");

  // ---- other lifecycle paths --------------------------------------------------------------------------------
  const c = await newUser("lifecycle");
  const cc = await checkout(c, "growth");
  await webhook("subscription.charged", cc.sub); // 'charged' arrives before 'activated'
  assert.equal(await planOf(c), "growth");
  await webhook("subscription.pending", cc.sub);
  assert.equal(await planOf(c), "growth");
  assert.equal((await c.json("/api/billing")).data.subscription.status, "pending");
  await webhook("subscription.charged", cc.sub);
  assert.equal((await c.json("/api/billing")).data.subscription.status, "active");
  await webhook("subscription.halted", cc.sub);
  assert.equal(await planOf(c), "free");
  ok("out-of-order 'charged', failed-renewal 'pending' (grace), recovery, and 'halted' → Free");

  const d = await newUser("mismatch");
  const dd = await checkout(d, "starter");
  await webhook("subscription.activated", dd.sub, { plan: PLAN.growth });
  assert.equal(await planOf(d), "free");
  ok("a webhook whose Razorpay plan id doesn't match the plan we sold is ignored");

  assert.equal((await webhook("subscription.activated", { id: "sub_doesnotexist", planId: PLAN.starter })).status, 200);
  const bad = await fetch(`${BASE}/api/razorpay/webhook`, { method: "POST", headers: { "x-razorpay-signature": hmac(WH_SECRET, "not json") }, body: "not json" });
  assert.equal(bad.status, 400);
  ok("unknown subscriptions are acknowledged (no retry storms); malformed bodies get 400");

  const e = await newUser("abandon");
  await checkout(e, "starter"); // opened the payment window but never paid
  assert.equal((await e.json("/api/billing/cancel", { method: "POST" })).status, 404, "nothing to cancel yet");
  const ee = await checkout(e, "growth"); // an abandoned checkout doesn't block choosing another plan
  assert.equal(ee.status, 200);
  const pay2 = `pay_${RUN}2`;
  await e.json("/api/billing/verify", { method: "POST", body: { razorpay_payment_id: pay2, razorpay_subscription_id: ee.sub.id, razorpay_signature: hmac(KEY_SECRET, `${pay2}|${ee.sub.id}`) } });
  assert.equal((await e.json("/api/billing")).data.subscription.status, "authenticated");
  assert.equal((await e.json("/api/billing/cancel", { method: "POST" })).data.cancelAtPeriodEnd, false);
  assert.equal(calls.filter((x) => x.url.endsWith("/cancel")).at(-1).body.cancel_at_cycle_end, false);
  assert.equal((await e.json("/api/billing")).data.subscription, null);
  ok("abandoned checkout doesn't block another plan; authorised-but-not-yet-charged subscriptions cancel immediately");

  // ---- plan setup script ---------------------------------------------------------------------------------------
  // Async on purpose: the fake Razorpay API lives in THIS process, so a synchronous spawn would deadlock.
  const run = () =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/razorpay-setup.mjs"],
        { env: { ...process.env, RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_API_BASE: `http://127.0.0.1:${PORT}` }, encoding: "utf8" },
        (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })
      )
    );
  const s1 = await run();
  assert.equal(s1.status, 0, s1.stderr);
  assert.match(s1.stdout, /RAZORPAY_PLAN_STARTER=plan_\w+/);
  assert.match(s1.stdout, /RAZORPAY_PLAN_PRO=plan_\w+/);
  assert.deepEqual(plans.map((p) => p.item.amount), [99900, 299900, 799900]);
  assert.ok(plans.every((p) => p.period === "monthly" && p.item.currency === "INR"));
  const s2 = await run();
  assert.equal(plans.length, 3, "second run must reuse plans, not create duplicates");
  assert.equal(s2.stdout, s1.stdout);
  ok("razorpay:setup creates the 3 monthly INR plans (₹999 / ₹2,999 / ₹7,999 in paise) and is idempotent");

  console.log(`\nAll ${passed} billing checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message);
  process.exitCode = 1;
} finally {
  api.close();
}
