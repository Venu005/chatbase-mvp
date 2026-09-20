// One-time setup: creates the monthly Razorpay plans that match src/lib/plans.ts (or reuses existing ones)
// and prints the environment lines to add to .env.
//   RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... pnpm razorpay:setup     (use TEST keys first)
import { PLANS } from "../src/lib/plans.ts";

const id = process.env.RAZORPAY_KEY_ID;
const secret = process.env.RAZORPAY_KEY_SECRET;
if (!id || !secret) {
  console.error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (in .env or the environment).");
  process.exit(1);
}
const base = (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/$/, "");
const auth = "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

async function rz(method, path, body) {
  const res = await fetch(`${base}/v1${path}`, { method, headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Razorpay ${method} ${path} failed: ${j?.error?.description ?? res.status}`);
  return j;
}

const existing = (await rz("GET", "/plans?count=100")).items ?? [];
console.log(`# Add these lines to .env (${id.startsWith("rzp_live") ? "LIVE" : "test"} mode)`);
for (const key of ["starter", "growth", "pro"]) {
  const p = PLANS[key];
  const name = `Chatbase India ${p.name}`;
  const amount = p.priceInr * 100; // paise
  let plan = existing.find((e) => e.item?.name === name && e.item.amount === amount && e.item.currency === "INR" && e.period === "monthly" && e.interval === 1);
  if (!plan) {
    plan = await rz("POST", "/plans", { period: "monthly", interval: 1, item: { name, amount, currency: "INR", description: `${p.credits} AI replies per month, up to ${p.agents} agents` } });
    console.error(`created ${name} (₹${p.priceInr}/month)`);
  } else {
    console.error(`reusing ${name} (₹${p.priceInr}/month)`);
  }
  console.log(`RAZORPAY_PLAN_${key.toUpperCase()}=${plan.id}`);
}
