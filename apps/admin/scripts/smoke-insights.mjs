// End-to-end test of the admin insights (business, growth, quality, operations), admin actions (plan, credits,
// read-only conversations) and the audit log, against the RUNNING customer app (:3000) and admin app (:3001).
// Needs DATABASE_URL, ADMIN_EMAILS and ADMIN_PASSWORD in .env, and SMTP_URL=smtp://127.0.0.1:4025 for the admin app
// (this script runs a fake mail server there). Start the apps with ALERTS=off so the customer app's own alert timer
// doesn't send mail during the other suites; this script triggers the alert check itself.
//   pnpm build && pnpm start      then      pnpm smoke:insights
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { createRequire } from "node:module";

const pg = createRequire(new URL("../../../packages/core/package.json", import.meta.url))("pg");
const ADMIN = process.env.ADMIN_BASE_URL ?? "http://localhost:3001";
const WEB = process.env.BASE_URL ?? "http://localhost:3000";
const IP = `10.97.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const RUN = crypto.randomBytes(3).toString("hex");
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  let cookie = "";
  return {
    async json(path, { method = "GET", body } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { "x-forwarded-for": IP, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return { status: res.status, data: await res.json().catch(() => ({})) };
    },
  };
}

// ---- fake mail server (alert e-mails) ------------------------------------------------------------------
const mails = [];
const smtp = net.createServer((sock) => {
  let buf = "";
  let inData = false;
  sock.write("220 fake ESMTP\r\n");
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        mails.push(buf.slice(0, end));
        buf = buf.slice(end + 5);
        inData = false;
        sock.write("250 queued\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const cmd = buf.slice(0, 4).toUpperCase();
      buf = buf.slice(nl + 2);
      if (cmd === "DATA") (inData = true), sock.write("354 go\r\n");
      else if (cmd === "QUIT") (sock.write("221 bye\r\n"), sock.end());
      else sock.write("250 OK\r\n");
    }
  });
  sock.on("error", () => {});
});
await new Promise((r) => smtp.listen(Number(process.env.FAKE_SMTP_PORT ?? 4025), "127.0.0.1", r));

async function chat(agentId, message) {
  const res = await fetch(`${WEB}/api/chat/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": IP },
    body: JSON.stringify({ message, sessionId: crypto.randomBytes(12).toString("hex"), channel: "widget" }),
  });
  assert.equal(res.status, 200, `chat failed: ${res.status}`);
  await res.text();
}

async function customer(tag) {
  const c = client(WEB);
  const email = `${tag}-${RUN}@insights.test`;
  assert.equal((await c.json("/api/auth/signup", { method: "POST", body: { email, password: "customer-pass-1" } })).status, 200);
  const id = (await c.json("/api/me")).data.user.id;
  return { c, email, id };
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const cleanup = [];
console.log(`Admin insights smoke test against ${ADMIN} (customer app ${WEB})\n`);

try {
  const anon = client(ADMIN);
  for (const p of ["business", "growth", "quality", "ops", "audit"]) assert.equal((await anon.json(`/api/admin/${p}`)).status, 401, p);
  assert.equal((await anon.json("/api/admin/alerts", { method: "POST" })).status, 401);
  const admin = client(ADMIN);
  const adminEmail = (process.env.ADMIN_EMAILS ?? "").split(",")[0].trim();
  assert.equal((await admin.json("/api/auth/login", { method: "POST", body: { email: adminEmail, password: process.env.ADMIN_PASSWORD } })).status, 200);
  ok("the insights, alerts and audit APIs need an admin sign-in");

  // ---- seed: A has an agent with real conversations; B pays (Growth) but is cancelling; C is a free account near its limit
  const A = await customer("shop");
  cleanup.push(A.id);
  const agentId = (await A.c.json("/api/agents", { method: "POST", body: { name: `Rice shop ${RUN}` } })).data.agent.id;
  await A.c.json(`/api/agents/${agentId}/sources`, {
    method: "POST",
    body: { type: "text", title: "Prices", text: "Basmati rice costs Rs 610 for a 5 kg bag. Delivery in Pune takes 2 days." },
  });
  for (let i = 0; i < 60 && (await A.c.json(`/api/agents/${agentId}/sources`)).data.sources.some((s) => s.status === "processing"); i++) await sleep(250);
  const questions = [`What is the price of basmati rice ${RUN}?`, `basmati rice ka daam kya hai ${RUN}`, `बासमती चावल की कीमत क्या है ${RUN}`, `Do you deliver to Pune ${RUN}?`];
  for (const qn of questions) await chat(agentId, qn);

  const B = await customer("payer");
  cleanup.push(B.id);
  await db.query("UPDATE users SET plan = 'growth' WHERE id = $1", [B.id]);
  await db.query(
    "INSERT INTO subscriptions (user_id, razorpay_subscription_id, plan, status, cancel_at_period_end) VALUES ($1, $2, 'growth', 'active', true)",
    [B.id, `sub_ins_${RUN}`]
  );
  const C = await customer("busy");
  cleanup.push(C.id);
  await db.query("INSERT INTO usage (user_id, period, used) VALUES ($1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 45)", [C.id]);

  // ---- business
  const biz = (await admin.json("/api/admin/business?days=7")).data;
  const bRow = biz.accounts.find((a) => a.id === B.id);
  assert.ok(bRow && bRow.revenue_inr === 2999 && bRow.at_risk && !bRow.comped, JSON.stringify(bRow));
  assert.ok(biz.mrr_inr >= 2999 && biz.arr_inr === biz.mrr_inr * 12 && biz.revenue_at_risk_inr >= 2999, JSON.stringify(biz));
  assert.ok(biz.planMix.find((p) => p.plan === "growth").paying >= 1);
  ok("business: MRR/ARR from paid plans, plan mix, profit per account, and revenue at risk from a cancelling subscription");

  // ---- admin actions: comped plan and bonus credits
  assert.equal((await admin.json(`/api/admin/accounts/${A.id}/plan`, { method: "POST", body: { plan: "starter" } })).status, 400, "a reason is required");
  const setPlan = await admin.json(`/api/admin/accounts/${A.id}/plan`, { method: "POST", body: { plan: "starter", reason: `partner trial ${RUN}` } });
  assert.equal(setPlan.status, 200, JSON.stringify(setPlan.data));
  assert.equal(setPlan.data.comped, true);
  const me1 = (await A.c.json("/api/me")).data;
  assert.equal(me1.user.plan, "starter");
  assert.equal(me1.usage.limit, 1000);
  const aRow = (await admin.json("/api/admin/business?days=7")).data.accounts.find((a) => a.id === A.id);
  assert.ok(!aRow || (aRow.comped && aRow.revenue_inr === 0), "a comped plan is not revenue: " + JSON.stringify(aRow));

  assert.equal((await admin.json(`/api/admin/accounts/${A.id}/credits`, { method: "POST", body: { credits: 0, reason: "nothing" } })).status, 400);
  const grant = await admin.json(`/api/admin/accounts/${A.id}/credits`, { method: "POST", body: { credits: 500, reason: `outage ${RUN}` } });
  assert.equal(grant.status, 200, JSON.stringify(grant.data));
  assert.equal((await A.c.json("/api/me")).data.usage.limit, 1500, "bonus credits raise this month's limit");
  const detail = (await admin.json(`/api/admin/accounts/${A.id}?days=7`)).data;
  assert.equal(detail.usage.limit, 1500);
  assert.deepEqual(detail.audit.map((e) => e.action).slice(0, 2), ["credits.grant", "plan.change"]);
  ok("an admin gives a comped plan (not counted as revenue) and bonus credits, each with a reason in the audit log");

  // ---- growth
  const gr = (await admin.json("/api/admin/growth?days=7")).data;
  assert.ok(gr.funnel.signups >= 3 && gr.funnel.created_agent >= 1 && gr.funnel.added_knowledge >= 1 && gr.funnel.went_live >= 1, JSON.stringify(gr.funnel));
  const thisCohort = gr.cohorts.at(-1);
  assert.ok(thisCohort.size >= 3 && thisCohort.retention.at(-1) > 0, JSON.stringify(thisCohort));
  const risk = gr.atRisk.find((r) => r.id === B.id);
  assert.ok(risk && risk.level === "high" && risk.reasons.includes("cancels at the end of the period"), JSON.stringify(risk));
  const up = gr.upgrade.find((u) => u.id === C.id);
  assert.ok(up && up.used === 45 && up.limit === 50, JSON.stringify(up));
  ok("growth: signup funnel, weekly cohorts, paying accounts at risk (with reasons), and upgrade candidates");

  // ---- quality
  const qa = (await admin.json("/api/admin/quality?days=1")).data;
  const langs = Object.fromEntries(qa.languages.map((l) => [l.lang, l.questions]));
  assert.ok(langs.en >= 2 && langs.hinglish >= 1 && langs.hi >= 1, JSON.stringify(qa.languages));
  assert.ok(qa.topics.find((t) => t.id === "price").questions >= 3 && qa.topics.find((t) => t.id === "delivery").questions >= 1, JSON.stringify(qa.topics));
  assert.ok(qa.topQuestions.some((x) => x.question.includes(`ka daam kya hai ${RUN}`)));
  assert.ok(qa.channels.some((c) => c.channel === "widget" && c.conversations >= 4));
  assert.ok(qa.busyHours.length === 7 && qa.busyHours.flat().reduce((a, b) => a + b, 0) >= 4);
  const health = qa.agents.find((x) => x.id === agentId);
  assert.ok(health && health.score >= 0 && health.score <= 100 && health.answers === 4, JSON.stringify(health));
  ok("quality: languages (English, Hinglish, Hindi), topics, top questions, channels, busy hours and agent health");

  // ---- read-only conversations, audited
  const list = await admin.json(`/api/admin/accounts/${A.id}/conversations`);
  assert.equal(list.status, 200);
  const convo = list.data.conversations.find((c) => c.first_question === questions[1]);
  assert.ok(convo && convo.messages === 2, JSON.stringify(list.data.conversations));
  const one = (await admin.json(`/api/admin/accounts/${A.id}/conversations?cid=${convo.id}`)).data;
  assert.deepEqual(one.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal((await admin.json(`/api/admin/accounts/${B.id}/conversations?cid=${convo.id}`)).status, 404, "a conversation is only shown under its own account");
  const log = (await admin.json(`/api/admin/audit?userId=${A.id}`)).data.entries.map((e) => e.action);
  assert.deepEqual(log.slice(0, 2), ["account.view_conversation", "account.view_conversations"]);
  assert.ok((await admin.json("/api/admin/audit")).data.entries.some((e) => e.target_email === A.email && e.admin_email === adminEmail));
  ok("admins can read an account's conversations (read-only); every look is in the audit log");

  // ---- operations and alerts
  const ops = (await admin.json("/api/admin/ops?days=1")).data;
  assert.ok(ops.providers.some((p) => p.provider === "mock" && p.calls >= 4), JSON.stringify(ops.providers));
  assert.ok(ops.daily.some((d) => d.provider === "mock" && d.p95_ms !== null));
  assert.ok(ops.cache.answers >= 4 && ops.cache.rate >= 0 && ops.cache.rate <= 1);
  await db.query("DELETE FROM ops_alerts WHERE key = 'answer_errors'");
  await db.query(
    `INSERT INTO ai_calls (user_id, agent_id, kind, channel, provider, model, status, error)
     SELECT $1, $2, 'answer', 'widget', 'mock', 'mock', 'error', 'Mock failure (500)' FROM generate_series(1, 30)`,
    [A.id, agentId]
  );
  const check = (await admin.json("/api/admin/alerts", { method: "POST" })).data;
  assert.ok(check.alerts.some((a) => a.key === "answer_errors" && a.level === "critical"), JSON.stringify(check));
  assert.ok(check.sent.includes("answer_errors"), JSON.stringify(check));
  for (let i = 0; i < 20 && !mails.some((m) => /answers failed/.test(m)); i++) await sleep(100);
  const mail = mails.find((m) => /answers failed/.test(m));
  assert.ok(mail && mail.includes(adminEmail) && /Subject: \[Critical\]/.test(mail), mail);
  const again = (await admin.json("/api/admin/alerts", { method: "POST" })).data;
  assert.ok(!again.sent.includes("answer_errors"), "an alert is e-mailed once per cooldown");
  assert.ok((await admin.json("/api/admin/overview?days=1")).data.alerts.some((a) => a.key === "answer_errors"), "the dashboard shows firing alerts");
  ok("operations: per-provider speed and failures, cache hit rate; a spike of failed answers e-mails the admins once");
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
} finally {
  // Remove the test accounts (and their fake failed answers), so they don't raise alerts for the next hour.
  if (cleanup.length) await db.query("DELETE FROM users WHERE id = ANY($1)", [cleanup]).catch(() => {});
  await db.query("DELETE FROM ops_alerts WHERE key = 'answer_errors'").catch(() => {});
  await db.end();
  smtp.close();
}
if (!process.exitCode) console.log(`\nAll ${passed} insights checks passed.`);
