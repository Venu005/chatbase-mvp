// End-to-end test of admin sign-in and admin management against the RUNNING admin app (and the customer app, to check the
// two sessions are separate). Needs ADMIN_EMAILS and ADMIN_PASSWORD in .env; signs in as the first ADMIN_EMAILS entry.
//   pnpm build && pnpm start      then      pnpm smoke:admin
import assert from "node:assert/strict";
import crypto from "node:crypto";

const ADMIN = process.env.ADMIN_BASE_URL ?? "http://localhost:3001";
const WEB = process.env.BASE_URL ?? "http://localhost:3000";
const IP = `10.98.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;

function client(base) {
  let cookie = "";
  return {
    cookie: () => cookie,
    setCookie: (c) => (cookie = c),
    async req(path, { method = "GET", body } = {}) {
      const res = await fetch(base + path, {
        method,
        redirect: "manual",
        headers: { "x-forwarded-for": IP, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
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

const rootEmail = (process.env.ADMIN_EMAILS ?? "").split(",")[0].trim().toLowerCase();
const rootPassword = process.env.ADMIN_PASSWORD ?? "";
console.log(`Admin smoke test against ${ADMIN} (customer app ${WEB})\n`);

try {
  assert.ok(rootEmail && rootPassword.length >= 12, "set ADMIN_EMAILS and ADMIN_PASSWORD (12+ characters) in .env");
  const anon = client(ADMIN);
  assert.equal((await anon.json("/api/admin/overview")).status, 401);
  assert.equal((await anon.json("/api/admin/admins")).status, 401);
  assert.match((await anon.req("/")).headers.get("location") ?? "", /\/login$/);
  assert.equal((await anon.req("/login")).status, 200);
  ok("signed out: the admin API answers 401 and the dashboard sends you to /login");

  assert.equal((await anon.json("/api/auth/login", { method: "POST", body: { email: rootEmail, password: rootPassword + "x" } })).status, 401);
  assert.equal((await anon.json("/api/auth/login", { method: "POST", body: { email: "nobody@smoke.test", password: rootPassword } })).status, 401);
  ok("a wrong password or an unknown e-mail is refused with the same error");

  // A customer account with the same e-mail and password must not get into the admin app, and vice versa.
  const customer = client(WEB);
  const cEmail = `cust-${crypto.randomBytes(4).toString("hex")}@smoke.test`;
  assert.equal((await customer.json("/api/auth/signup", { method: "POST", body: { email: cEmail, password: "customer-pass-1" } })).status, 200);
  const stolen = client(ADMIN);
  stolen.setCookie(customer.cookie().replace("cb_session=", "cb_admin="));
  assert.equal((await stolen.json("/api/admin/overview")).status, 401);
  assert.equal((await customer.json("/api/admin/overview")).status, 404);
  ok("customer sessions don't work in the admin app, and the customer app has no admin API");

  const root = client(ADMIN);
  assert.equal((await root.json("/api/auth/login", { method: "POST", body: { email: rootEmail.toUpperCase(), password: rootPassword } })).status, 200);
  assert.equal((await root.req("/")).status, 200);
  assert.equal((await root.json("/api/admin/overview?days=1")).status, 200);
  const rootSession = client(WEB);
  rootSession.setCookie(root.cookie().replace("cb_admin=", "cb_session="));
  assert.equal((await rootSession.json("/api/me")).status, 401);
  ok("the ADMIN_EMAILS admin signs in with ADMIN_PASSWORD (and that session is useless in the customer app)");

  let list = (await root.json("/api/admin/admins")).data.admins;
  const me = list.find((a) => a.email === rootEmail);
  assert.ok(me && me.you && me.fromEnv && me.id, JSON.stringify(list));
  assert.equal((await root.json(`/api/admin/admins/${me.id}`, { method: "DELETE" })).status, 400);
  ok("admins are listed; you can't remove yourself");

  const newEmail = `ops-${crypto.randomBytes(4).toString("hex")}@smoke.test`;
  assert.equal((await root.json("/api/admin/admins", { method: "POST", body: { email: newEmail, password: "short" } })).status, 400);
  const added = await root.json("/api/admin/admins", { method: "POST", body: { email: newEmail, name: "Ops", password: "first-password-1" } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal((await root.json("/api/admin/admins", { method: "POST", body: { email: newEmail.toUpperCase(), password: "first-password-1" } })).status, 409);
  list = (await root.json("/api/admin/admins")).data.admins;
  const row = list.find((a) => a.email === newEmail);
  assert.ok(row && !row.fromEnv && row.has_password && row.created_by === rootEmail, JSON.stringify(row));
  ok("an admin adds another admin (12+ character password, no duplicates); the list shows who added them");

  const ops = client(ADMIN);
  assert.equal((await ops.json("/api/auth/login", { method: "POST", body: { email: newEmail, password: "first-password-1" } })).status, 200);
  assert.equal((await ops.json("/api/admin/overview?days=1")).status, 200);
  assert.equal((await ops.json(`/api/admin/admins/${me.id}`, { method: "DELETE" })).status, 400, "ADMIN_EMAILS admins can't be removed here");
  ok("the new admin signs in with their own password; ADMIN_EMAILS admins can't be removed from the app");

  const opsOther = client(ADMIN);
  await opsOther.json("/api/auth/login", { method: "POST", body: { email: newEmail, password: "first-password-1" } });
  assert.equal((await ops.json("/api/admin/me/password", { method: "POST", body: { currentPassword: "wrong", newPassword: "second-password-2" } })).status, 400);
  assert.equal((await ops.json("/api/admin/me/password", { method: "POST", body: { currentPassword: "first-password-1", newPassword: "second-password-2" } })).status, 200);
  assert.equal((await ops.json("/api/admin/admins")).status, 200, "this session is renewed");
  assert.equal((await opsOther.json("/api/admin/admins")).status, 401, "other sessions end");
  assert.equal((await client(ADMIN).json("/api/auth/login", { method: "POST", body: { email: newEmail, password: "first-password-1" } })).status, 401);
  assert.equal((await client(ADMIN).json("/api/auth/login", { method: "POST", body: { email: newEmail, password: "second-password-2" } })).status, 200);
  ok("an admin changes their own password; their other sessions end");

  assert.equal((await root.json(`/api/admin/admins/${row.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await ops.json("/api/admin/overview")).status, 401);
  assert.equal((await client(ADMIN).json("/api/auth/login", { method: "POST", body: { email: newEmail, password: "second-password-2" } })).status, 401);
  ok("a removed admin is signed out at once and can't sign in again");

  assert.equal((await root.json("/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await root.json("/api/admin/overview")).status, 401);
  ok("log out");

  console.log(`\nAll ${passed} admin checks passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
}
