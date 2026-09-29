// End-to-end test of password reset and per-agent allowed websites against a RUNNING server, with a fake SMTP server.
// Start the app with  SMTP_URL=smtp://127.0.0.1:4025 EMAIL_FROM="Bot <bot@example.com>" pnpm start , then  pnpm smoke:account
import net from "node:net";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SMTP_PORT = Number(process.env.FAKE_SMTP_PORT ?? 4025);
const IP = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // fresh rate-limit buckets per run
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake SMTP server (records every message) -----------------------------------------------------
const mails = [];
function decodeBody(raw) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  let body = rest.join("\n\n");
  if (/content-transfer-encoding:\s*base64/i.test(head)) body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  else if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const header = (n) => (head.match(new RegExp(`^${n}:\\s*(.*)$`, "im")) ?? [])[1] ?? "";
  return { to: header("To"), subject: header("Subject"), body };
}
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
        mails.push(decodeBody(buf.slice(0, end)));
        buf = buf.slice(end + 5);
        inData = false;
        sock.write("250 queued\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const cmd = buf.slice(0, 4).toUpperCase();
      buf = buf.slice(nl + 2);
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250 fake\r\n");
      else if (cmd === "DATA") (inData = true), sock.write("354 go\r\n");
      else if (cmd === "QUIT") (sock.write("221 bye\r\n"), sock.end());
      else sock.write("250 OK\r\n");
    }
  });
  sock.on("error", () => {});
});
await new Promise((r) => smtp.listen(SMTP_PORT, "127.0.0.1", r));
async function waitMail(to, timeout = 6000) {
  const t0 = Date.now();
  for (;;) {
    const m = mails.find((x) => x.to.includes(to));
    if (m || Date.now() - t0 > timeout) return m;
    await sleep(100);
  }
}

// ---- tiny cookie-jar client ------------------------------------------------------------------------
function client() {
  let cookie = "";
  return {
    async json(path, { method = "GET", body, headers = {} } = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: { "x-forwarded-for": IP, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return { status: res.status, data: await res.json().catch(() => ({})) };
    },
  };
}

try {
  console.log(`Account smoke test against ${BASE}\n`);
  const email = `reset${Date.now()}@example.com`;
  const a = client();
  assert.equal((await a.json("/api/auth/signup", { method: "POST", body: { email, password: "old-password-1" } })).status, 200);
  const created = await a.json("/api/agents", { method: "POST", body: { name: "Domain Bot" } });
  const agentId = created.data.agent.id;

  // ---- password reset -------------------------------------------------------------------------------
  const unknown = await client().json("/api/auth/forgot", { method: "POST", body: { email: `nobody${Date.now()}@example.com` } });
  const known = await client().json("/api/auth/forgot", { method: "POST", body: { email } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(known, unknown);
  ok("forgot-password answers the same for known and unknown e-mails");

  const mail = await waitMail(email);
  assert.ok(mail, "reset e-mail should arrive");
  const token = mail.body.match(/reset-password\?token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, mail.body);
  ok("reset link e-mailed to the account owner");

  assert.equal((await client().json("/api/auth/reset", { method: "POST", body: { token: "x".repeat(43), password: "new-password-1" } })).status, 400);
  assert.equal((await client().json("/api/auth/reset", { method: "POST", body: { token, password: "short" } })).status, 400);
  const b = client();
  assert.equal((await b.json("/api/auth/reset", { method: "POST", body: { token, password: "new-password-1" } })).status, 200);
  assert.equal((await b.json("/api/me")).status, 200);
  assert.equal((await client().json("/api/auth/reset", { method: "POST", body: { token, password: "another-pass-1" } })).status, 400);
  ok("reset link sets the new password, signs this browser in, and works only once");

  assert.equal((await a.json("/api/me")).status, 401);
  ok("resetting the password signs out existing sessions");
  assert.equal((await client().json("/api/auth/login", { method: "POST", body: { email, password: "old-password-1" } })).status, 401);
  assert.equal((await client().json("/api/auth/login", { method: "POST", body: { email, password: "new-password-1" } })).status, 200);
  ok("old password rejected, new password works");

  // ---- allowed websites -------------------------------------------------------------------------------
  const bad = await b.json(`/api/agents/${agentId}`, { method: "PATCH", body: { allowedDomains: ["not a domain"] } });
  assert.equal(bad.status, 400);
  assert.equal((await b.json(`/api/agents/${agentId}`, { method: "PATCH", body: { allowedDomains: ["https://www.Shop.in/contact", "shop.in", ""] } })).status, 200);
  assert.deepEqual((await b.json(`/api/agents/${agentId}`)).data.agent.allowed_domains, ["www.shop.in", "shop.in"]);
  ok("allowed websites are validated, normalised and de-duplicated");

  const embed = async (headers) => (await (await fetch(`${BASE}/embed/${agentId}`, { headers })).text()).includes("isn&#x27;t enabled for this website");
  assert.ok(!(await embed({ "sec-fetch-dest": "iframe", referer: "https://shop.in/" })));
  assert.ok(!(await embed({ "sec-fetch-dest": "iframe", referer: "https://blog.shop.in/post" })));
  assert.ok(await embed({ "sec-fetch-dest": "iframe", referer: "https://evil.example/" }));
  assert.ok(await embed({ "sec-fetch-dest": "iframe" }));
  assert.ok(!(await embed({ "sec-fetch-dest": "document" })));
  ok("the chat can be framed only by allowed websites; the full-page link still works");

  const cfg = async (origin) => (await (await fetch(`${BASE}/api/public/agents/${agentId}`, { headers: { origin } })).json()).allowed;
  assert.equal(await cfg("https://www.shop.in"), true);
  assert.equal(await cfg("https://evil.example"), false);
  ok("widget config tells widget.js whether to show the bubble on this website");

  assert.equal((await b.json(`/api/agents/${agentId}`, { method: "PATCH", body: { allowedDomains: [] } })).status, 200);
  assert.ok(!(await embed({ "sec-fetch-dest": "iframe", referer: "https://evil.example/" })));
  ok("an empty list allows any website again");

  console.log(`\nAll ${passed} account checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message);
  process.exitCode = 1;
} finally {
  smtp.close();
}
