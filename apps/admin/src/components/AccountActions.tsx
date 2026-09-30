"use client";

import { useState } from "react";
import { api, json } from "@chatbase/core/client";
import { when } from "@/lib/format";
import { auditLabel, describeAudit, type AuditEntry } from "./Insights";

const PLANS = ["free", "starter", "growth", "pro"];

type Convo = { id: string; channel: string; updated_at: string; mode: string; agent_name: string; messages: number; first_question: string | null; has_gap: boolean; has_down: boolean };
type Msg = { id: string; role: "user" | "assistant" | "human"; content: string; feedback: number | null; knowledge_gap: boolean; created_at: string };

/** Admin actions on one account: change the plan, grant credits, read its conversations (read-only, audited). */
export default function AccountActions({
  user,
  audit,
  onChanged,
}: {
  user: { id: string; email: string; plan: string };
  audit: AuditEntry[];
  onChanged: () => void;
}) {
  const [plan, setPlan] = useState(user.plan);
  const [planWhy, setPlanWhy] = useState("");
  const [credits, setCredits] = useState("");
  const [creditsWhy, setCreditsWhy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [convos, setConvos] = useState<Convo[] | null>(null);
  const [open, setOpen] = useState<{ id: string; messages: Msg[] } | null>(null);

  async function run(fn: () => Promise<string>) {
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  const changePlan = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ warning: string | null }>(`/api/admin/accounts/${user.id}/plan`, { method: "POST", ...json({ plan, reason: planWhy }) });
      setPlanWhy("");
      return `Plan set to ${plan}${plan === "free" ? "" : " (comped: not counted as revenue)"}.${r.warning ? ` ${r.warning}` : ""}`;
    });
  };
  const grant = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ bonus: number }>(`/api/admin/accounts/${user.id}/credits`, { method: "POST", ...json({ credits: Number(credits), reason: creditsWhy }) });
      setCredits("");
      setCreditsWhy("");
      return `Done: ${r.bonus} bonus credits this month.`;
    });
  };
  async function showConvos() {
    try {
      setConvos((await api<{ conversations: Convo[] }>(`/api/admin/accounts/${user.id}/conversations`)).conversations);
      onChanged(); // the look is in the audit log now
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  async function openConvo(id: string) {
    try {
      setOpen({ id, messages: (await api<{ messages: Msg[] }>(`/api/admin/accounts/${user.id}/conversations?cid=${id}`)).messages });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <div className="card stack">
      <h3>Actions</h3>
      <div className="admin-actions">
        <form onSubmit={changePlan}>
          <label>
            Plan
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              {PLANS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <input required minLength={3} maxLength={300} value={planWhy} onChange={(e) => setPlanWhy(e.target.value)} placeholder="Why (e.g. 30-day trial for a partner)" />
          <button className="btn" disabled={plan === user.plan}>Change plan</button>
          <span className="muted small">Paid plans set here are comped (not revenue). A Razorpay payment replaces them.</span>
        </form>
        <form onSubmit={grant}>
          <label>
            Bonus credits for this month
            <input type="number" required min={-100000} max={100000} value={credits} onChange={(e) => setCredits(e.target.value)} placeholder="e.g. 500 (negative to take back)" />
          </label>
          <input required minLength={3} maxLength={300} value={creditsWhy} onChange={(e) => setCreditsWhy(e.target.value)} placeholder="Why (e.g. outage on 12 Sep)" />
          <button className="btn">Grant credits</button>
        </form>
      </div>
      {msg && <p className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</p>}

      <div className="stack">
        <div className="row-between">
          <strong>Conversations (read-only)</strong>
          {!convos && (
            <button className="btn ghost" onClick={showConvos}>Show conversations</button>
          )}
        </div>
        {!convos && <p className="muted small">For support. Opening them is recorded in the audit log.</p>}
        {convos && convos.length === 0 && <p className="muted">No conversations yet.</p>}
        {convos && convos.length > 0 && (
          <div className="table-wrap">
            <table className="data-table admin-table">
              <thead>
                <tr>
                  <th>Last message</th>
                  <th>Agent · channel</th>
                  <th>First question</th>
                  <th className="num">Messages</th>
                </tr>
              </thead>
              <tbody>
                {convos.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => openConvo(c.id)}>
                    <td className="nowrap">{when(c.updated_at)}</td>
                    <td>
                      {c.agent_name}
                      <div className="muted small">
                        {c.channel}
                        {c.mode === "human" && " · with a person"}
                        {c.has_gap && " · gap"}
                        {c.has_down && " · 👎"}
                      </div>
                    </td>
                    <td><div className="clip">{c.first_question ?? <span className="muted">(none)</span>}</div></td>
                    <td className="num">{c.messages}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open && (
          <div className="passage">
            <div className="row-between">
              <strong>Conversation</strong>
              <button className="link-btn" onClick={() => setOpen(null)}>Close</button>
            </div>
            {open.messages.map((m) => (
              <div key={m.id} className={`convo-msg ${m.role}`}>
                <span className="muted small">
                  {m.role === "user" ? "Visitor" : m.role === "human" ? "Business" : "Bot"} · {when(m.created_at)}
                  {m.knowledge_gap && " · not in sources"}
                  {m.feedback === 1 ? " · 👍" : m.feedback === -1 ? " · 👎" : ""}
                </span>
                <div>{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {audit.length > 0 && (
        <details className="small">
          <summary className="muted">Admin actions on this account ({audit.length})</summary>
          <ul>
            {audit.map((e) => (
              <li key={e.id}>
                {when(e.created_at)} · {e.admin_email}: {auditLabel(e.action)} {describeAudit(e) && `(${describeAudit(e)})`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
