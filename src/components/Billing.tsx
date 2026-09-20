"use client";

import { useCallback, useEffect, useState } from "react";
import { api, json } from "@/lib/client";

type PlanCard = { id: string; name: string; priceInr: number; credits: number; agents: number; available: boolean };
type BillingInfo = {
  configured: boolean;
  email: string;
  name: string;
  plan: { id: string; name: string };
  usage: { used: number; limit: number };
  subscription: { plan: string; status: string; currentEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  plans: PlanCard[];
};

// Minimal typing for Razorpay's Checkout script (https://checkout.razorpay.com/v1/checkout.js).
type RazorpayResponse = { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string };
declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (ev: string, cb: (r: unknown) => void) => void };
  }
}

function loadCheckoutScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load the payment window. Check your connection and try again."));
    document.body.appendChild(s);
  });
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export default function Billing() {
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setInfo(await api<BillingInfo>("/api/billing"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // After payment, the plan changes when Razorpay's webhook arrives (usually seconds). Poll until it does.
  async function waitForPlan(target: string) {
    for (let i = 0; i < 20; i++) {
      const fresh = await api<BillingInfo>("/api/billing");
      if (fresh.plan.id === target) return void setInfo(fresh);
      await new Promise((r) => setTimeout(r, 1500));
    }
    setNote("Payment received. Your plan will switch as soon as Razorpay confirms it. Refresh in a minute.");
    await load();
  }

  async function subscribe(plan: string) {
    if (!info) return;
    setError("");
    setNote("");
    setBusy(plan);
    try {
      const c = await api<{ subscriptionId: string; keyId: string; planName: string }>("/api/billing/checkout", { method: "POST", ...json({ plan }) });
      await loadCheckoutScript();
      const rz = new window.Razorpay!({
        key: c.keyId,
        subscription_id: c.subscriptionId,
        name: "Chatbase India",
        description: `${c.planName} plan, billed monthly`,
        prefill: { name: info.name, email: info.email },
        theme: { color: "#4f46e5" },
        handler: async (r: RazorpayResponse) => {
          try {
            await api("/api/billing/verify", { method: "POST", ...json(r) });
            setNote("Payment successful. Activating your plan…");
            await waitForPlan(plan);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy("");
          }
        },
        modal: { ondismiss: () => setBusy("") },
      });
      rz.open();
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  }

  async function cancel() {
    if (!window.confirm("Cancel your subscription? If a billing period is running you keep your plan until it ends.")) return;
    setError("");
    try {
      const r = await api<{ cancelAtPeriodEnd: boolean }>("/api/billing/cancel", { method: "POST" });
      setNote(r.cancelAtPeriodEnd ? "Cancelled. You keep your plan until the end of the current billing period." : "Cancelled.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!info) return <main className="page"><p className={error ? "error-text" : "muted"}>{error || "Loading…"}</p></main>;
  const sub = info.subscription;

  return (
    <main className="page">
      <h1>Plans & billing</h1>
      <section className="card usage">
        <div>
          <strong>Current plan: {info.plan.name}</strong>
          <span className="muted"> · {info.usage.used.toLocaleString("en-IN")} / {info.usage.limit.toLocaleString("en-IN")} message credits used this month</span>
        </div>
        {sub && (
          <div className="muted small">
            Subscription: {sub.status}
            {sub.currentEnd && ` · current period ends ${new Date(sub.currentEnd).toLocaleDateString("en-IN")}`}
            {sub.cancelAtPeriodEnd && " · will not renew"}
          </div>
        )}
        {sub && !sub.cancelAtPeriodEnd && <div><button className="btn danger" onClick={cancel}>Cancel subscription</button></div>}
      </section>

      {!info.configured && <p className="muted">Online payments aren&apos;t set up on this server yet, so upgrading is disabled.</p>}
      {error && <p className="error-text">{error}</p>}
      {note && <p className="ok-text">{note}</p>}

      <div className="grid plans">
        {info.plans.map((p) => {
          const current = info.plan.id === p.id;
          return (
            <div key={p.id} className={`card plan${current ? " current" : ""}`}>
              <h3>{p.name}</h3>
              <div className="price">{p.priceInr ? <>{inr(p.priceInr)}<span className="muted small"> / month</span></> : "Free"}</div>
              <ul className="muted small">
                <li>{p.credits.toLocaleString("en-IN")} AI replies / month</li>
                <li>{p.agents} agent{p.agents === 1 ? "" : "s"}</li>
              </ul>
              {current ? (
                <span className="badge ready">Current plan</span>
              ) : p.id === "free" ? null : (
                <button className="btn" disabled={!info.configured || !p.available || !!sub || !!busy} onClick={() => subscribe(p.id)}>
                  {busy === p.id ? "Opening…" : !p.available ? "Not available" : sub ? "Cancel current plan first" : `Choose ${p.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
