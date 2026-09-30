"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@chatbase/core/client";
import { Tile } from "@chatbase/ui/charts";
import { compact, inr, n, secs, share, when } from "@/lib/format";

// The Business, Growth, Quality, Operations and Audit log tabs of the admin app (one API route each).

function useData<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await api<T>(url));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
}

function Loading({ error }: { error: string }) {
  return error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>;
}

/** A horizontal bar for a share (0–1). */
function Bar({ v, tone }: { v: number; tone?: "bad" }) {
  return (
    <span className={`hbar${tone ? ` ${tone}` : ""}`} aria-hidden>
      <span style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} />
    </span>
  );
}

const Empty = ({ cols, text }: { cols: number; text: string }) => (
  <tr>
    <td colSpan={cols} className="muted">{text}</td>
  </tr>
);

// ---- Business -----------------------------------------------------------------------------------------------
type Business = {
  rate: number;
  rateAssumed: boolean;
  mrr_inr: number;
  arr_inr: number;
  paying_accounts: number;
  comped_accounts: number;
  arpa_inr: number;
  ai_cost_30d_inr: number;
  gross_margin: number | null;
  revenue_at_risk_inr: number;
  new_paid: number;
  churned: number;
  unprofitable: number;
  planMix: { plan: string; name: string; price_inr: number; accounts: number; paying: number; comped: number; mrr_inr: number; cost_inr: number; avg_cost_inr: number; margin: number | null }[];
  accounts: { id: string; email: string; plan: string; comped: boolean; subscription: string | null; answers: number; revenue_inr: number; cost_inr: number; profit_inr: number; margin: number | null; at_risk: boolean }[];
};

export function BusinessTab({ days, onOpen }: { days: number; onOpen: (id: string) => void }) {
  const { data: b, error } = useData<Business>(`/api/admin/business?days=${days}`);
  if (!b) return <Loading error={error} />;
  return (
    <section className="stack">
      <div className="tiles">
        <Tile label="MRR" value={inr(b.mrr_inr)} note={`ARR ${inr(b.arr_inr)}`} />
        <Tile label="Paying accounts" value={n(b.paying_accounts)} note={`${n(b.comped_accounts)} on a comped plan · ARPA ${inr(b.arpa_inr)}`} />
        <Tile label="AI cost (30 days)" value={inr(b.ai_cost_30d_inr)} note={`gross margin ${share(b.gross_margin)}`} tone={b.gross_margin !== null && b.gross_margin < 0.6 ? "bad" : undefined} />
        <Tile label="Unprofitable accounts" value={n(b.unprofitable)} tone={b.unprofitable ? "bad" : undefined} note="AI cost above plan price" />
        <Tile label="Revenue at risk" value={inr(b.revenue_at_risk_inr)} tone={b.revenue_at_risk_inr ? "bad" : undefined} note="cancelling or payment failing" />
        <Tile label={`New paid · churned (${days === 1 ? "today" : `${days} days`})`} value={`${n(b.new_paid)} · ${n(b.churned)}`} />
      </div>
      {b.rateAssumed && <p className="muted small">Costs are converted at an assumed ₹{b.rate} per US$; set <code>USD_INR_RATE</code> for exact figures.</p>}

      <div className="card stack">
        <h3>Plans</h3>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th className="num">Price</th>
                <th className="num">Accounts</th>
                <th className="num">Paying</th>
                <th className="num">Comped</th>
                <th className="num">MRR</th>
                <th className="num">AI cost (30 d)</th>
                <th className="num">Per account</th>
                <th className="num">Margin</th>
              </tr>
            </thead>
            <tbody>
              {b.planMix.map((p) => (
                <tr key={p.plan}>
                  <td className="plan">{p.name}</td>
                  <td className="num">{inr(p.price_inr)}</td>
                  <td className="num">{n(p.accounts)}</td>
                  <td className="num">{n(p.paying)}</td>
                  <td className="num">{n(p.comped)}</td>
                  <td className="num">{inr(p.mrr_inr)}</td>
                  <td className="num">{inr(p.cost_inr)}</td>
                  <td className="num">{inr(p.avg_cost_inr)}</td>
                  <td className={`num${p.margin !== null && p.margin < 0 ? " bad" : ""}`}>{share(p.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h3>Profit per account (last 30 days)</h3>
        <p className="muted small">Plan price minus AI cost, worst first. Free and comped accounts bring no revenue, so any AI cost is a loss.</p>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Plan</th>
                <th className="num">Answers</th>
                <th className="num">Revenue</th>
                <th className="num">AI cost</th>
                <th className="num">Profit</th>
                <th className="num">Margin</th>
              </tr>
            </thead>
            <tbody>
              {b.accounts.length === 0 && <Empty cols={7} text="No revenue or AI cost in the last 30 days." />}
              {b.accounts.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => onOpen(a.id)}>
                  <td>
                    {a.email}
                    {a.at_risk && <span className="badge failed" style={{ marginLeft: 6 }}>at risk</span>}
                  </td>
                  <td>
                    <span className="plan">{a.plan}</span>
                    {a.comped && <span className="muted small"> comped</span>}
                  </td>
                  <td className="num">{n(a.answers)}</td>
                  <td className="num">{inr(a.revenue_inr)}</td>
                  <td className="num">{inr(a.cost_inr)}</td>
                  <td className={`num${a.profit_inr < 0 ? " bad" : ""}`}>{inr(a.profit_inr)}</td>
                  <td className="num">{share(a.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---- Growth -------------------------------------------------------------------------------------------------
type Growth = {
  funnel: { signups: number; created_agent: number; added_knowledge: number; went_live: number; paid: number };
  cohorts: { week: string; size: number; retention: number[] }[];
  atRisk: { id: string; email: string; plan: string; mrr_inr: number; last14: number; prev14: number; level: "high" | "medium"; reasons: string[] }[];
  upgrade: { id: string; email: string; plan: string; used: number; limit: number; share: number; projected: number }[];
};

export function GrowthTab({ days, onOpen }: { days: number; onOpen: (id: string) => void }) {
  const { data: g, error } = useData<Growth>(`/api/admin/growth?days=${days}`);
  if (!g) return <Loading error={error} />;
  const f = g.funnel;
  const steps: [string, number][] = [
    ["Signed up", f.signups],
    ["Created an agent", f.created_agent],
    ["Added knowledge", f.added_knowledge],
    ["Got a real conversation", f.went_live],
    ["Paying", f.paid],
  ];
  const weeks = Math.max(0, ...g.cohorts.map((c) => c.retention.length));
  return (
    <section className="stack">
      <div className="card stack">
        <h3>Signup funnel ({days === 1 ? "signed up today" : `signed up in the last ${days} days`})</h3>
        <div className="funnel">
          {steps.map(([label, v], i) => (
            <div key={label} className="funnel-row">
              <span>{label}</span>
              <Bar v={f.signups ? v / f.signups : 0} />
              <strong className="num">{n(v)}</strong>
              <span className="muted small">{i === 0 ? "" : steps[i - 1][1] ? `${share(v / steps[i - 1][1])} of previous step` : "–"}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card stack">
        <h3>Weekly cohorts</h3>
        <p className="muted small">Share of each signup week's accounts that had real (non-playground) conversations 0, 1, 2… weeks later.</p>
        <div className="table-wrap">
          <table className="data-table admin-table cohorts">
            <thead>
              <tr>
                <th>Signup week</th>
                <th className="num">Accounts</th>
                {Array.from({ length: weeks }, (_, i) => (
                  <th key={i} className="num">W{i}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.cohorts.length === 0 && <Empty cols={2} text="No signups in the last 8 weeks." />}
              {g.cohorts.map((c) => (
                <tr key={c.week}>
                  <td className="nowrap">{new Date(`${c.week}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</td>
                  <td className="num">{n(c.size)}</td>
                  {Array.from({ length: weeks }, (_, i) => (
                    <td key={i} className="num cell" style={i < c.retention.length ? { background: `color-mix(in srgb, var(--chart) ${Math.round(c.retention[i] * 70)}%, transparent)` } : undefined}>
                      {i < c.retention.length ? share(c.retention[i]) : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h3>Paying accounts at risk</h3>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Plan</th>
                <th>Risk</th>
                <th>Why</th>
                <th className="num">Answers (14 d · prior 14 d)</th>
              </tr>
            </thead>
            <tbody>
              {g.atRisk.length === 0 && <Empty cols={5} text="No paying account shows warning signs." />}
              {g.atRisk.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                  <td>{r.email}</td>
                  <td className="nowrap"><span className="plan">{r.plan}</span> <span className="muted small">{inr(r.mrr_inr)}/mo</span></td>
                  <td><span className={`badge ${r.level === "high" ? "alert" : "processing"}`}>{r.level}</span></td>
                  <td className="small">{r.reasons.join(" · ")}</td>
                  <td className="num">{n(r.last14)} · {n(r.prev14)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h3>Upgrade candidates</h3>
        <p className="muted small">Accounts that used 80% of this month's credits, or will run out before the month ends at their current pace.</p>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Plan</th>
                <th>Credits this month</th>
                <th className="num">Projected for the month</th>
              </tr>
            </thead>
            <tbody>
              {g.upgrade.length === 0 && <Empty cols={4} text="Nobody is close to their limit." />}
              {g.upgrade.map((u) => (
                <tr key={u.id} className="clickable" onClick={() => onOpen(u.id)}>
                  <td>{u.email}</td>
                  <td className="plan">{u.plan}</td>
                  <td>
                    {n(u.used)} / {n(u.limit)}
                    <div className={`meter small-meter${u.share >= 0.9 ? " hot" : ""}`} aria-hidden>
                      <div style={{ width: `${Math.min(100, u.share * 100)}%` }} />
                    </div>
                  </td>
                  <td className={`num${u.projected > u.limit ? " bad" : ""}`}>{n(u.projected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---- Quality ------------------------------------------------------------------------------------------------
type Rates = { questions: number; share: number; gap_rate: number; down_rate: number | null };
type QRow = { question: string; count: number; gaps: number; agents: number };
type Quality = {
  questions: number;
  sampled: boolean;
  languages: ({ lang: string; name: string } & Rates)[];
  topics: ({ id: string; label: string } & Rates)[];
  topQuestions: QRow[];
  topGaps: QRow[];
  channels: { channel: string; conversations: number; handoffs: number; answers: number }[];
  busyHours: number[][];
  agents: { id: string; name: string; email: string; answers: number; gap_rate: number; score: number; issues: string[] }[];
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CHANNELS: Record<string, string> = { widget: "Website widget", whatsapp: "WhatsApp", embed: "Embedded page", voice: "Website voice", phone: "Phone calls" };

export function QualityTab({ days }: { days: number }) {
  const { data: d, error } = useData<Quality>(`/api/admin/quality?days=${days}`);
  const [allAgents, setAllAgents] = useState(false);
  if (!d) return <Loading error={error} />;
  const heatMax = Math.max(1, ...d.busyHours.flat());
  const peak = d.busyHours.flatMap((row, di) => row.map((v, h) => ({ v, di, h }))).sort((a, b) => b.v - a.v)[0];
  const gaps = d.topics.reduce((t, x) => t + x.gap_rate * x.questions, 0);
  return (
    <section className="stack">
      <div className="tiles">
        <Tile label="Questions analysed" value={compact(d.questions)} note={d.sampled ? "newest 20,000 of the period" : "real visitors, all channels"} />
        <Tile label="Not in sources" value={share(d.questions ? gaps / d.questions : 0)} note="platform-wide knowledge gaps" />
        <Tile label="Top language" value={d.languages[0]?.name.split(" (")[0] ?? "–"} note={d.languages[0] ? `${share(d.languages[0].share)} of questions` : undefined} />
        <Tile label="Busiest hour (IST)" value={peak && peak.v ? `${DAYS[peak.di]} ${String(peak.h).padStart(2, "0")}:00` : "–"} note={peak && peak.v ? `${n(peak.v)} answers` : undefined} />
      </div>

      <div className="admin-charts">
        <div className="card stack">
          <h3>Languages</h3>
          <table className="data-table admin-table">
            <tbody>
              {d.languages.length === 0 && <Empty cols={3} text="No questions in this period." />}
              {d.languages.map((l) => (
                <tr key={l.lang}>
                  <td>{l.name}</td>
                  <td><Bar v={l.share} /> <span className="muted small">{share(l.share)}</span></td>
                  <td className="num small">{n(l.questions)} · <span className={l.gap_rate > 0.3 ? "bad" : "muted"}>{share(l.gap_rate)} gaps</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card stack">
          <h3>Channels</h3>
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="num">Conversations</th>
                <th className="num">Answers</th>
                <th className="num">Handed to a person</th>
              </tr>
            </thead>
            <tbody>
              {d.channels.length === 0 && <Empty cols={4} text="No conversations in this period." />}
              {d.channels.map((c) => (
                <tr key={c.channel}>
                  <td>{CHANNELS[c.channel] ?? c.channel}</td>
                  <td className="num">{n(c.conversations)}</td>
                  <td className="num">{n(c.answers)}</td>
                  <td className="num">{n(c.handoffs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h3>Topics</h3>
        <p className="muted small">What visitors ask about (from keywords in English, Hinglish and Hindi), and how often each goes unanswered.</p>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Share</th>
                <th className="num">Questions</th>
                <th className="num">Not in sources</th>
                <th className="num">👎 of rated</th>
              </tr>
            </thead>
            <tbody>
              {d.topics.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td><Bar v={t.share} /> <span className="muted small">{share(t.share)}</span></td>
                  <td className="num">{n(t.questions)}</td>
                  <td className="num"><Bar v={t.gap_rate} tone="bad" /> {share(t.gap_rate)}</td>
                  <td className="num">{share(t.down_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="admin-charts">
        <QuestionTable title="Most asked questions" rows={d.topQuestions} empty="No questions in this period." />
        <QuestionTable title="Most common knowledge gaps" rows={d.topGaps} empty="No knowledge gaps: every question was covered." gaps />
      </div>

      <div className="card stack">
        <h3>Busy hours (India time)</h3>
        <div className="heat" role="table" aria-label="Answers by weekday and hour">
          <div className="heat-row" role="row">
            <span className="heat-d" />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="heat-h muted">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>
            ))}
          </div>
          {d.busyHours.map((row, di) => (
            <div key={di} className="heat-row" role="row">
              <span className="heat-d muted">{DAYS[di]}</span>
              {row.map((v, h) => (
                <span
                  key={h}
                  className="heat-c"
                  title={`${DAYS[di]} ${String(h).padStart(2, "0")}:00 – ${n(v)} answers`}
                  style={{ background: v ? `color-mix(in srgb, var(--chart) ${Math.round(15 + (v / heatMax) * 85)}%, transparent)` : undefined }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="card stack">
        <h3>Agent health</h3>
        <p className="muted small">Agents that answered in this period, worst first. 100 = no failed answers, few knowledge gaps, happy visitors, no broken sources.</p>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th className="num">Health</th>
                <th>Agent · account</th>
                <th className="num">Answers</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {d.agents.length === 0 && <Empty cols={4} text="No agent answered in this period." />}
              {(allAgents ? d.agents : d.agents.slice(0, 15)).map((a) => (
                <tr key={a.id}>
                  <td className="num"><span className={`health ${a.score < 50 ? "bad" : a.score < 80 ? "mid" : "good"}`}>{a.score}</span></td>
                  <td>
                    {a.name}
                    <div className="muted small">{a.email}</div>
                  </td>
                  <td className="num">{n(a.answers)}</td>
                  <td className="small">{a.issues.length ? a.issues.join(" · ") : <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {d.agents.length > 15 && (
          <button className="link-btn" onClick={() => setAllAgents(!allAgents)}>
            {allAgents ? "Show the 15 worst" : `Show all ${d.agents.length} agents`}
          </button>
        )}
      </div>
    </section>
  );
}

function QuestionTable({ title, rows, empty, gaps }: { title: string; rows: QRow[]; empty: string; gaps?: boolean }) {
  return (
    <div className="card stack">
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="data-table admin-table">
          <thead>
            <tr>
              <th>Question</th>
              <th className="num">{gaps ? "Unanswered" : "Asked"}</th>
              <th className="num">Agents</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <Empty cols={3} text={empty} />}
            {rows.map((r) => (
              <tr key={r.question}>
                <td><div className="clip">{r.question}</div></td>
                <td className="num">{n(gaps ? r.gaps : r.count)}</td>
                <td className="num">{n(r.agents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Operations ---------------------------------------------------------------------------------------------
export type Alert = { key: string; level: "critical" | "warning"; message: string };
type Ops = {
  providers: { provider: string; calls: number; errors: number; fallbacks: number }[];
  daily: { day: string; provider: string; calls: number; errors: number; fallbacks: number; p50_ms: number | null; p95_ms: number | null }[];
  cache: { answers: number; cached: number; rate: number };
  ingestion: { added: number; ready: number; failed: number; p50_seconds: number | null; p95_seconds: number | null };
  alerts: Alert[];
  sent: { key: string; last_sent_at: string; last_message: string }[];
};

export function AlertBanner({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null;
  return (
    <div className="alert-banner" role="alert">
      {alerts.map((a) => (
        <p key={a.key}>
          <span className={`badge ${a.level === "critical" ? "alert" : "processing"}`}>{a.level}</span> {a.message}
        </p>
      ))}
    </div>
  );
}

export function OpsTab({ days }: { days: number }) {
  const { data: o, error, reload } = useData<Ops>(`/api/admin/ops?days=${days}`);
  const [msg, setMsg] = useState("");
  if (!o) return <Loading error={error} />;
  async function check() {
    try {
      const r = await api<{ alerts: Alert[]; sent: string[] }>("/api/admin/alerts", { method: "POST" });
      setMsg(r.alerts.length ? `${r.alerts.length} alert(s) firing; e-mailed: ${r.sent.length ? r.sent.join(", ") : "none new (already sent within the cooldown)"}.` : "All clear.");
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  const byDay = [...new Set(o.daily.map((d) => d.day))].sort().reverse();
  const ing = o.ingestion;
  return (
    <section className="stack">
      <div className="card stack">
        <div className="row-between">
          <h3>Alerts</h3>
          <button className="btn ghost" onClick={check}>Check now</button>
        </div>
        {o.alerts.length ? <AlertBanner alerts={o.alerts} /> : <p className="ok-text">All clear: no alert is firing.</p>}
        {msg && <p className="muted small">{msg}</p>}
        {o.sent.length > 0 && (
          <details className="small">
            <summary className="muted">Last e-mailed alerts</summary>
            <ul>
              {o.sent.map((s) => (
                <li key={s.key}>{when(s.last_sent_at)}: {s.last_message}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="tiles">
        <Tile label="Answer cache hit rate" value={share(o.cache.rate)} note={`${n(o.cache.cached)} of ${n(o.cache.answers)} answers from the cache`} />
        <Tile label="Sources added" value={n(ing.added)} note={`${n(ing.ready)} ready · ${n(ing.failed)} failed`} tone={ing.failed ? "bad" : undefined} />
        <Tile label="Time to ready" value={ing.p50_seconds === null ? "–" : secs(ing.p50_seconds * 1000)} note={ing.p95_seconds === null ? undefined : `p95 ${secs(ing.p95_seconds * 1000)}`} />
      </div>

      <div className="card stack">
        <h3>Providers</h3>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Provider</th>
                <th className="num">Answers</th>
                <th className="num">Failed</th>
                <th className="num">By backup</th>
                <th className="num">First word p50</th>
                <th className="num">p95</th>
              </tr>
            </thead>
            <tbody>
              {byDay.length === 0 && <Empty cols={7} text="No answers in this period." />}
              {byDay.flatMap((day) =>
                o.daily
                  .filter((d) => d.day === day)
                  .map((d) => (
                    <tr key={`${day}${d.provider}`}>
                      <td className="nowrap">{new Date(`${day}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</td>
                      <td><code>{d.provider}</code></td>
                      <td className="num">{n(d.calls)}</td>
                      <td className={`num${d.errors / d.calls > 0.02 ? " bad" : ""}`}>{share(d.errors / d.calls)}</td>
                      <td className="num">{share(d.fallbacks / d.calls)}</td>
                      <td className="num">{secs(d.p50_ms)}</td>
                      <td className={`num${(d.p95_ms ?? 0) > 8000 ? " bad" : ""}`}>{secs(d.p95_ms)}</td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---- Audit log ----------------------------------------------------------------------------------------------
export type AuditEntry = { id: string; admin_email: string; action: string; target_email?: string | null; details: Record<string, unknown>; created_at: string };

const ACTIONS: Record<string, string> = {
  "plan.change": "Changed plan",
  "credits.grant": "Granted credits",
  "account.view_conversations": "Viewed conversation list",
  "account.view_conversation": "Read a conversation",
  "admin.add": "Added an admin",
  "admin.remove": "Removed an admin",
  reindex: "Re-indexed",
};

export function describeAudit(e: AuditEntry): string {
  const d = e.details as Record<string, string | number>;
  if (e.action === "plan.change") return `${d.from} → ${d.to}: ${d.reason}`;
  if (e.action === "credits.grant") return `${Number(d.credits) > 0 ? "+" : ""}${d.credits} credits: ${d.reason}`;
  if (e.action === "admin.add" || e.action === "admin.remove") return String(d.email);
  if (e.action === "reindex") return `${d.sourcesQueued} sources queued`;
  return "";
}

export function AuditTab() {
  const { data, error } = useData<{ entries: AuditEntry[] }>("/api/admin/audit");
  if (!data) return <Loading error={error} />;
  return (
    <section className="stack">
      <p className="muted">Every change an admin made, and every time an admin read a customer's conversations.</p>
      <div className="card table-wrap">
        <table className="data-table admin-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Account</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.length === 0 && <Empty cols={5} text="No admin actions yet." />}
            {data.entries.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{when(e.created_at)}</td>
                <td>{e.admin_email}</td>
                <td>{ACTIONS[e.action] ?? e.action}</td>
                <td>{e.target_email ?? "–"}</td>
                <td className="small">{describeAudit(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export const auditLabel = (a: string) => ACTIONS[a] ?? a;
