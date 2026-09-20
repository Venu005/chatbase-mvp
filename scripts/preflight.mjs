// Checks your .env before you start the app:   pnpm preflight          (offline checks + database)
//                                               pnpm preflight --live   (also calls OpenAI/Anthropic/Sarvam, Razorpay, Meta, SMTP)
//                                               pnpm preflight --live --email you@example.com   (also sends a test e-mail)
// Exit code 1 if anything is broken, so it can gate a deploy.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import nodemailer from "nodemailer";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const testEmailTo = args.includes("--email") ? args[args.indexOf("--email") + 1] : null;

const v = (n) => (process.env[n] ?? "").trim();
const isPlaceholder = (s) => /replace[-_ ]?me|change[-_ ]?me|^your[-_ ]|xxxx|^\.{3}$/i.test(s);
const set = (n) => !!v(n) && !isPlaceholder(v(n));
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  ${c(32, "✓")} ${m}`);
const warn = (m) => (warns++, console.log(`  ${c(33, "!")} ${m}`));
const fail = (m) => (fails++, console.log(`  ${c(31, "✗")} ${m}`));
const info = (m) => console.log(`    ${c(90, m)}`);
const section = (t) => console.log(`\n${c(1, t)}`);
const fetchJson = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { ok: res.ok, status: res.status, body };
};
const errMsg = (r) => r.body?.error?.message ?? r.body?.error ?? (typeof r.body === "string" ? r.body : JSON.stringify(r.body).slice(0, 160));

console.log(c(1, "Chatbase India: environment check") + (LIVE ? c(90, "  (live checks on)") : c(90, "  (add --live to test your API keys for real)")));
if (!fs.existsSync(path.join(process.cwd(), ".env"))) warn("No .env file in this folder. Copy .env.example to .env and fill it in (variables already set in the shell are still checked below).");

// Next.js expands $VAR inside .env values (Node's own loader does not), so a "$" in a password silently changes it.
try {
  const dollar = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n").filter((l) => /^[A-Z][A-Z0-9_]*=.*\$/.test(l)).map((l) => l.split("=")[0]);
  if (dollar.length) warn(`These .env values contain a "$", which Next.js expands into something else: ${dollar.join(", ")}. Write it URL-encoded as %24.`);
} catch {
  /* no .env file: already reported above */
}

// ---- core -----------------------------------------------------------------------------------------------------------
section("Core");
const dim = Number(v("EMBEDDING_DIM") || 1536);
if (!v("DATABASE_URL")) fail("DATABASE_URL is not set");
else {
  const client = new pg.Client({ connectionString: v("DATABASE_URL"), connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    ok("Database connection works");
    const ext = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    ext.rowCount ? ok("pgvector extension is installed") : fail("pgvector extension is missing: run `pnpm migrate` (needs a Postgres with pgvector, e.g. the pgvector/pgvector image)");
    const hasTable = (await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
    if (!hasTable) fail("Database has no tables yet: run `pnpm migrate`");
    else {
      const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
      const files = fs.readdirSync(path.join(process.cwd(), "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
      const pending = files.filter((f) => !applied.has(f));
      pending.length ? fail(`Migrations not applied: ${pending.join(", ")}. Run \`pnpm migrate\``) : ok(`All ${files.length} migrations are applied`);
      const col = await client.query("SELECT atttypmod FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'").catch(() => null);
      const dbDim = col?.rows[0]?.atttypmod;
      if (dbDim && dbDim !== dim) fail(`EMBEDDING_DIM=${dim} but your database was created with ${dbDim}. Set EMBEDDING_DIM=${dbDim}, or start from an empty database and re-run \`pnpm migrate\``);
      else if (dbDim) ok(`Vector size ${dbDim} matches EMBEDDING_DIM`);
    }
  } catch (e) {
    fail(`Cannot connect to the database: ${e.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}
if (v("AUTH_SECRET").length < 32 || isPlaceholder(v("AUTH_SECRET"))) fail("AUTH_SECRET must be a random string of 32+ characters (generate one: openssl rand -base64 48)");
else ok("AUTH_SECRET is set");
const appUrl = v("APP_URL");
if (!appUrl) warn("APP_URL is not set (needed for e-mail links, WhatsApp callback URLs and secure cookies)");
else if (/localhost|127\.0\.0\.1/.test(appUrl)) warn(`APP_URL is ${appUrl}: fine for development, but WhatsApp/Razorpay webhooks and e-mail links need your public https address`);
else if (!appUrl.startsWith("https://")) warn("APP_URL should start with https:// in production (it turns on secure cookies)");
else ok(`APP_URL is ${appUrl}`);
if (!v("ENCRYPTION_KEY")) warn("ENCRYPTION_KEY is not set: WhatsApp tokens are encrypted with a key derived from AUTH_SECRET, so rotating AUTH_SECRET would make them unreadable. Set a separate random ENCRYPTION_KEY (openssl rand -base64 48).");
else if (v("ENCRYPTION_KEY").length < 32 || isPlaceholder(v("ENCRYPTION_KEY"))) fail("ENCRYPTION_KEY must be 32+ random characters");
else ok("ENCRYPTION_KEY is set");
if (v("ALLOW_PRIVATE_URLS") === "true") warn("ALLOW_PRIVATE_URLS=true lets customers make the server fetch internal addresses. Never use it on a public deployment.");

// ---- models ------------------------------------------------------------------------------------------------------------------
section("AI models");
const llm = (v("LLM_PROVIDER") || "mock").toLowerCase();
const emb = (v("EMBEDDING_PROVIDER") || "mock").toLowerCase();
const openaiBase = (v("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "");
const embBase = (v("EMBEDDING_BASE_URL") || openaiBase).replace(/\/$/, "");
const embKey = v("EMBEDDING_API_KEY") || v("OPENAI_API_KEY");
const sarvamBase = (v("SARVAM_BASE_URL") || "https://api.sarvam.ai/v1").replace(/\/$/, "");
const anthropicBase = (v("ANTHROPIC_BASE_URL") || "https://api.anthropic.com").replace(/\/$/, "");

if (llm === "mock") warn("LLM_PROVIDER=mock: answers just quote your documents. Fine for a demo, not for customers.");
else if (llm === "openai") {
  if (!set("OPENAI_API_KEY")) fail("LLM_PROVIDER=openai needs OPENAI_API_KEY");
  if (!set("LLM_MODEL")) fail("LLM_PROVIDER=openai needs LLM_MODEL (a model id your account can use)");
  else if (set("OPENAI_API_KEY")) ok(`Chat model: openai-compatible / ${v("LLM_MODEL")}`);
} else if (llm === "anthropic") {
  if (!set("ANTHROPIC_API_KEY")) fail("LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
  if (!set("LLM_MODEL")) fail("LLM_PROVIDER=anthropic needs LLM_MODEL (a model id your account can use)");
  else if (set("ANTHROPIC_API_KEY")) ok(`Chat model: anthropic / ${v("LLM_MODEL")}`);
} else if (llm === "sarvam") {
  if (!set("SARVAM_API_KEY")) fail("LLM_PROVIDER=sarvam needs SARVAM_API_KEY");
  else ok(`Chat model: sarvam / ${v("LLM_MODEL") || "sarvam-105b (default)"}`);
} else fail(`Unknown LLM_PROVIDER "${llm}" (use mock | openai | anthropic | sarvam)`);

if (emb === "mock") warn("EMBEDDING_PROVIDER=mock: search only matches shared words, it is not semantic. Use a real embedding model for customers.");
else if (emb === "openai") {
  if (!embKey || isPlaceholder(embKey)) fail("EMBEDDING_PROVIDER=openai needs EMBEDDING_API_KEY (or OPENAI_API_KEY)");
  else ok(`Embeddings: ${v("EMBEDDING_MODEL") || "text-embedding-3-small (default)"} at ${embBase}, ${dim} dimensions`);
} else fail(`Unknown EMBEDDING_PROVIDER "${emb}" (use mock | openai)`);
if (llm === "sarvam" && emb === "mock") warn("Sarvam has no embeddings API: set EMBEDDING_PROVIDER=openai (OpenAI or any OpenAI-compatible multilingual model) so your content can be searched.");

if (LIVE) {
  try {
    if (llm === "openai" && set("OPENAI_API_KEY") && set("LLM_MODEL")) {
      const r = await fetchJson(`${openaiBase}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${v("OPENAI_API_KEY")}` }, body: JSON.stringify({ model: v("LLM_MODEL"), max_tokens: 5, messages: [{ role: "user", content: "Say OK" }] }) });
      r.ok ? ok("Live: chat model answered") : fail(`Live: chat model call failed (${r.status}): ${errMsg(r)}`);
    }
    if (llm === "anthropic" && set("ANTHROPIC_API_KEY") && set("LLM_MODEL")) {
      const r = await fetchJson(`${anthropicBase}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": v("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: v("LLM_MODEL"), max_tokens: 5, messages: [{ role: "user", content: "Say OK" }] }) });
      r.ok ? ok("Live: chat model answered") : fail(`Live: chat model call failed (${r.status}): ${errMsg(r)}`);
    }
    if (llm === "sarvam" && set("SARVAM_API_KEY")) {
      const r = await fetchJson(`${sarvamBase}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "api-subscription-key": v("SARVAM_API_KEY") }, body: JSON.stringify({ model: v("LLM_MODEL") || "sarvam-105b", max_tokens: 16, reasoning_effort: null, messages: [{ role: "user", content: "Say OK" }] }) });
      r.ok ? ok("Live: Sarvam answered") : fail(`Live: Sarvam call failed (${r.status}): ${errMsg(r)}`);
    }
    if (emb === "openai" && embKey && !isPlaceholder(embKey)) {
      const sendDims = v("EMBEDDING_SEND_DIMENSIONS") === "true";
      const r = await fetchJson(`${embBase}/embeddings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${embKey}` }, body: JSON.stringify({ model: v("EMBEDDING_MODEL") || "text-embedding-3-small", input: ["नमस्ते, hello"], ...(sendDims ? { dimensions: dim } : {}) }) });
      if (!r.ok) fail(`Live: embeddings call failed (${r.status}): ${errMsg(r)}`);
      else {
        const got = r.body?.data?.[0]?.embedding?.length;
        got === dim ? ok(`Live: embeddings work and return ${got} dimensions (matches EMBEDDING_DIM)`) : fail(`Live: the embedding model returns ${got} dimensions but EMBEDDING_DIM=${dim}. Fix EMBEDDING_DIM (before \`pnpm migrate\`) or set EMBEDDING_SEND_DIMENSIONS=true if the model supports it.`);
      }
    }
  } catch (e) {
    fail(`Live model check failed: ${e.message}`);
  }
}

// ---- WhatsApp ---------------------------------------------------------------------------------------------------------------------
section("WhatsApp");
const graphBase = `${(v("WHATSAPP_GRAPH_BASE_URL") || "https://graph.facebook.com").replace(/\/$/, "")}/${v("WHATSAPP_GRAPH_VERSION") || "v25.0"}`;
info("Manual connect (customer pastes their own token) needs nothing here: it works as soon as APP_URL is public https.");
const metaVars = ["META_APP_ID", "META_APP_SECRET", "META_ES_CONFIG_ID", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"];
const metaSet = metaVars.filter(set);
if (metaSet.length === 0) info("Embedded Signup (\"Connect with Facebook\" button) is off. To enable it set " + metaVars.join(", ") + " (see docs/embedded-signup.md).");
else if (metaSet.length < metaVars.length) fail(`Embedded Signup is half configured. Missing: ${metaVars.filter((n) => !set(n)).join(", ")}`);
else {
  ok("Embedded Signup variables are all set");
  if (LIVE) {
    try {
      const r = await fetchJson(`${graphBase}/${encodeURIComponent(v("META_APP_ID"))}?fields=name&access_token=${encodeURIComponent(`${v("META_APP_ID")}|${v("META_APP_SECRET")}`)}`);
      r.ok ? ok(`Live: Meta accepts META_APP_ID + META_APP_SECRET (app "${r.body?.name ?? "?"}")`) : fail(`Live: Meta rejected the app id/secret (${r.status}): ${errMsg(r)}`);
    } catch (e) {
      fail(`Live Meta check failed: ${e.message}`);
    }
    info("META_ES_CONFIG_ID and the webhook URL can only be verified by trying the signup once. See docs/embedded-signup.md.");
  }
}

// ---- Razorpay --------------------------------------------------------------------------------------------------------------------------
section("Razorpay billing");
const rzBase = (v("RAZORPAY_API_BASE") || "https://api.razorpay.com").replace(/\/$/, "");
if (!set("RAZORPAY_KEY_ID") && !set("RAZORPAY_KEY_SECRET")) info("Billing is off (no RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET): plans can't be purchased, the app otherwise works.");
else {
  if (!set("RAZORPAY_KEY_ID") || !set("RAZORPAY_KEY_SECRET")) fail("Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET");
  else {
    const mode = v("RAZORPAY_KEY_ID").startsWith("rzp_live_") ? "LIVE" : v("RAZORPAY_KEY_ID").startsWith("rzp_test_") ? "test" : "unknown";
    mode === "LIVE" ? warn("Razorpay keys are LIVE keys: real money will move.") : mode === "test" ? ok("Razorpay keys are test-mode keys") : warn("RAZORPAY_KEY_ID doesn't start with rzp_test_ or rzp_live_");
    if (!set("RAZORPAY_WEBHOOK_SECRET")) fail("RAZORPAY_WEBHOOK_SECRET is missing: without the webhook, paid plans are never activated. Use the secret you typed when creating the webhook in the Razorpay dashboard.");
    else ok("RAZORPAY_WEBHOOK_SECRET is set");
    const plans = ["STARTER", "GROWTH", "PRO"].filter((p) => set(`RAZORPAY_PLAN_${p}`));
    plans.length ? ok(`Plan ids set for: ${plans.join(", ")}`) : fail("No RAZORPAY_PLAN_* set: run `pnpm razorpay:setup` and paste the lines it prints");
    if (LIVE) {
      try {
        const auth = { authorization: `Basic ${Buffer.from(`${v("RAZORPAY_KEY_ID")}:${v("RAZORPAY_KEY_SECRET")}`).toString("base64")}` };
        const r = await fetchJson(`${rzBase}/v1/plans?count=1`, { headers: auth });
        if (!r.ok) fail(`Live: Razorpay rejected the API keys (${r.status}): ${errMsg(r)}`);
        else {
          ok("Live: Razorpay accepts the API keys");
          for (const p of plans) {
            const pr = await fetchJson(`${rzBase}/v1/plans/${encodeURIComponent(v(`RAZORPAY_PLAN_${p}`))}`, { headers: auth });
            pr.ok ? ok(`Live: RAZORPAY_PLAN_${p} exists (${pr.body?.item?.name ?? "plan"}, ${(pr.body?.item?.amount ?? 0) / 100} ${pr.body?.item?.currency ?? ""}/${pr.body?.interval ?? "?"} ${pr.body?.period ?? ""})`) : fail(`Live: RAZORPAY_PLAN_${p} not found in this Razorpay account (${pr.status}). Plans belong to the account and to test/live mode.`);
          }
        }
      } catch (e) {
        fail(`Live Razorpay check failed: ${e.message}`);
      }
    }
  }
}

// ---- e-mail ------------------------------------------------------------------------------------------------------------------------------
section("E-mail (human-handoff alerts)");
if (!set("SMTP_URL")) info("SMTP_URL is empty: owners are not e-mailed when a customer asks for a person (the dashboard still shows it).");
else {
  ok("SMTP_URL is set");
  if (!v("EMAIL_FROM")) warn("EMAIL_FROM is empty: set it to an address your SMTP provider allows, e.g. \"Chatbase India <alerts@yourdomain.in>\"");
  if (LIVE) {
    try {
      const t = nodemailer.createTransport(v("SMTP_URL"));
      await t.verify();
      ok("Live: SMTP login works");
      if (testEmailTo) {
        await t.sendMail({ from: v("EMAIL_FROM") || "Chatbase India <noreply@localhost>", to: testEmailTo, subject: "Chatbase India test e-mail", text: "If you can read this, handoff alerts will reach you." });
        ok(`Live: test e-mail sent to ${testEmailTo}`);
      }
    } catch (e) {
      fail(`Live SMTP check failed: ${e.message}`);
    }
  }
}

console.log("");
if (fails) console.log(c(31, `${fails} problem(s) to fix`) + (warns ? c(33, `, ${warns} warning(s)`) : ""));
else console.log(c(32, "No blocking problems") + (warns ? c(33, `, ${warns} warning(s) above`) : ""));
process.exit(fails ? 1 : 0);
