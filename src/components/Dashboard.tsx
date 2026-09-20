"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, json } from "@/lib/client";

type AgentRow = { id: string; name: string; brand_color: string; source_count: number; conversation_count: number; waiting_count: number };
type Me = { usage: { used: number; limit: number; plan: string; agentLimit: number } };

export default function Dashboard() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([api<{ agents: AgentRow[] }>("/api/agents"), api<Me>("/api/me")]);
      setAgents(a.agents);
      setMe(m);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ agent: { id: string } }>("/api/agents", { method: "POST", ...json({ name }) });
      window.location.href = `/dashboard/agents/${r.agent.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const pct = me ? Math.min(100, Math.round((me.usage.used / me.usage.limit) * 100)) : 0;

  return (
    <main className="page">
      {me && (
        <section className="card usage">
          <div>
            <strong>{me.usage.plan} plan</strong>
            <span className="muted">
              {" "}
              · {me.usage.used.toLocaleString("en-IN")} / {me.usage.limit.toLocaleString("en-IN")} message credits used this month
            </span>{" "}
            <Link href="/dashboard/billing">Upgrade</Link>
          </div>
          <div className="meter" aria-hidden>
            <div style={{ width: `${pct}%` }} />
          </div>
        </section>
      )}

      <h2>Your agents</h2>
      {error && <p className="error-text">{error}</p>}
      {agents && agents.length === 0 && <p className="muted">No agents yet. Create your first one below.</p>}
      <div className="grid">
        {agents?.map((a) => (
          <Link key={a.id} href={`/dashboard/agents/${a.id}`} className="card agent-card">
            <span className="dot" style={{ background: a.brand_color }} />
            <strong>{a.name}</strong>
            {a.waiting_count > 0 && <span className="badge alert" style={{ alignSelf: "flex-start" }}>{a.waiting_count} customer{a.waiting_count === 1 ? "" : "s"} waiting</span>}
            <span className="muted">
              {a.source_count} source{a.source_count === 1 ? "" : "s"} · {a.conversation_count} chat{a.conversation_count === 1 ? "" : "s"}
            </span>
          </Link>
        ))}
      </div>

      <form className="card row-form" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New agent name, e.g. “Support bot”" required maxLength={80} />
        <button className="btn" disabled={busy}>
          Create agent
        </button>
      </form>
    </main>
  );
}
