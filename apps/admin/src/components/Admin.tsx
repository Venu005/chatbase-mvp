"use client";

import { useCallback, useEffect, useState } from "react";
import { api, json } from "@chatbase/core/client";
import { ColumnChart, Tile } from "@chatbase/ui/charts";
import Admins from "./Admins";

// ---- types (mirroring /api/admin/*) -------------------------------------------------------------------
type Totals = {
  accounts: number;
  new_accounts: number;
  paying_accounts: number;
  agents: number;
  conversations: number;
  active_accounts: number;
  answers: number;
  errors: number;
  partial: number;
  fallbacks: number;
  retried: number;
  avg_first_token_ms: number;
  p95_first_token_ms: number;
  avg_total_ms: number;
  input_tokens: string;
  output_tokens: string;
  embed_tokens: string;
  answer_cost_usd: number;
  ingest_cost_usd: number;
  unpriced_calls: number;
  thumbs_up: number;
  thumbs_down: number;
  gaps: number;
};
type Account = {
  id: string;
  email: string;
  name: string;
  plan: string;
  created_at: string;
  agents: number;
  credits_used: number;
  credits_limit: number;
  conversations: number;
  answers: number;
  errors: number;
  tokens: string;
  cost_usd: number;
  thumbs_down: number;
  last_active: string | null;
};
type Problem = {
  id: string;
  created_at: string;
  status: "ok" | "partial" | "error";
  provider: string;
  model: string;
  attempts: number;
  fallback_used: boolean;
  error: string | null;
  question: string | null;
  email: string;
  agent_name: string | null;
  channel: string | null;
};
type ModelRow = {
  kind: string;
  provider: string;
  model: string;
  calls: number;
  errors: number;
  input_tokens: string;
  output_tokens: string;
  estimated: boolean;
  cost_usd: number | null;
  unpriced: boolean;
  avg_first_token_ms: number | null;
};
type Overview = {
  days: number;
  usdInr: number | null;
  config: { llm: string; fallback: string | null; embedding: string; pricesConfigured: boolean };
  totals: Totals;
  series: { day: string; answers: number; errors: number; cost_usd: number }[];
  models: ModelRow[];
  accounts: Account[];
  problems: Problem[];
  ingestion: {
    queued: number;
    running: number;
    retrying: number;
    failed: number;
    ready: number;
    passages: number;
    failedSources: { id: string; title: string; type: string; error: string | null; attempts: number; updated_at: string; agent_name: string; email: string }[];
  };
  embedding: { stale: number; untracked: number; total: number };
};
type CallRow = {
  id: string;
  created_at: string;
  kind: string;
  status: string;
  channel: string | null;
  model: string;
  question: string | null;
  first_token_ms: number | null;
  total_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  fallback_used: boolean;
  attempts: number;
  agent_name: string | null;
  passages: number;
  fixes: number;
};
type AccountDetail = {
  user: { id: string; email: string; name: string; plan: string; created_at: string };
  subscription: { plan: string; status: string; current_end: string | null; cancel_at_period_end: boolean } | null;
  agents: {
    id: string;
    name: string;
    sources: number;
    failed_sources: number;
    passages: number;
    qa_answers: number;
    whatsapp: boolean;
    leads: number;
    conversations: number;
    answers: number;
    cost_usd: number;
    gaps: number;
    thumbs_down: number;
    lead_mode: string;
    allowed_domains: number;
  }[];
  calls: CallRow[];
};
type Trace = {
  call: Record<string, unknown> & {
    id: string;
    created_at: string;
    status: string;
    provider: string;
    model: string;
    prompt_version: string | null;
    error: string | null;
    input_tokens: number;
    output_tokens: number;
    tokens_estimated: boolean;
    cost_usd: number | null;
    first_token_ms: number | null;
    total_ms: number | null;
    attempts: number;
    fallback_used: boolean;
    question: string | null;
    search_query: string | null;
    rewrite_model: string | null;
    email: string;
    agent_name: string | null;
    channel: string | null;
  };
  answer: string | null;
  feedback: number | null;
  retrieved: { chunkId: number; score: number; title: string; url: string | null; via?: string; content: string | null }[];
  fixes: { id: string; score: number; question: string; answer: string | null }[];
};

// ---- formatting ---------------------------------------------------------------------------------------
const n = (v: number | string) => Number(v).toLocaleString("en-IN");
/** 950 · 12.4K · 3.2L (lakh) · 1.5Cr (crore) */
function compact(v: number | string): string {
  const x = Number(v);
  const f = (d: number, u: string) => `${(x / d).toFixed(x / d < 10 ? 1 : 0).replace(/\.0$/, "")}${u}`;
  return x < 1000 ? x.toLocaleString("en-IN") : x < 100_000 ? f(1000, "K") : x < 10_000_000 ? f(100_000, "L") : f(10_000_000, "Cr");
}
const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : "–");
const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const when = (d: string | null) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");
function usd(v: number | null | undefined, rate: number | null): string {
  if (v === null || v === undefined) return "no price";
  const d = v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  return rate ? `${d} · ₹${(v * rate).toFixed(v * rate < 1 ? 2 : 0)}` : d;
}

const TABS = ["Overview", "Accounts", "Problems", "Models & ingestion", "Admins"] as const;
type Tab = (typeof TABS)[number];

export default function Admin() {
  const [days, setDays] = useState<1 | 7 | 30 | 90>(7);
  const [tab, setTab] = useState<Tab>("Overview");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [trace, setTrace] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>(`/api/admin/overview?days=${days}`));
      setError("");
    } catch (e) {
      if ((e as Error).message === "Please sign in") window.location.href = "/login";
      setError((e as Error).message);
    }
  }, [days]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <main className="page wide"><p className="error-text">{error}</p></main>;
  if (!data) return <main className="page wide"><p className="muted">Loading…</p></main>;
  const t = data.totals;
  const rate = data.usdInr;
  const rated = t.thumbs_up + t.thumbs_down;
  const cost = t.answer_cost_usd + t.ingest_cost_usd;

  return (
    <main className="page wide admin">
      <div className="row-between admin-head">
        <div>
          <h1>Admin</h1>
          <p className="muted small">
            Chat model <code>{data.config.llm}</code>
            {data.config.fallback && <> · backup <code>{data.config.fallback}</code></>} · embeddings <code>{data.config.embedding}</code>
          </p>
        </div>
        <div className="seg" role="group" aria-label="Period">
          {([1, 7, 30, 90] as const).map((d) => (
            <button type="button" key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>
              {d === 1 ? "Today" : `${d} days`}
            </button>
          ))}
        </div>
      </div>

      <nav className="tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "active" : ""} onClick={() => setTab(x)}>
            {x}
            {x === "Problems" && data.problems.some((p) => p.status === "error") && <span className="badge alert" style={{ marginLeft: 6 }}>{t.errors}</span>}
          </button>
        ))}
      </nav>

      {tab === "Overview" && (
        <section className="stack">
          <div className="tiles">
            <Tile label="Active accounts" value={n(t.active_accounts)} note={`of ${n(t.accounts)} · ${n(t.new_accounts)} new · ${n(t.paying_accounts)} paying`} />
            <Tile label="Answers" value={compact(t.answers)} note={`${n(t.conversations)} conversations · ${n(t.agents)} agents`} />
            <Tile
              label="Failed answers"
              value={pct(t.errors, t.answers)}
              tone={t.answers && t.errors / t.answers > 0.02 ? "bad" : undefined}
              note={`${n(t.errors)} failed · ${n(t.partial)} cut off · ${n(t.fallbacks)} by backup`}
            />
            <Tile label="Time to first word" value={secs(t.avg_first_token_ms)} note={`p95 ${secs(t.p95_first_token_ms)} · full answer ${secs(t.avg_total_ms)}`} />
            <Tile
              label="AI cost"
              value={usd(cost, null)}
              note={
                !data.config.pricesConfigured
                  ? "Set LLM_PRICES to see costs"
                  : [
                      rate && `₹${n(Math.round(cost * rate))} total`,
                      t.answers && `${rate ? `₹${((t.answer_cost_usd / t.answers) * rate).toFixed(2)}` : usd(t.answer_cost_usd / t.answers, null)} per answer`,
                      t.unpriced_calls && `${n(t.unpriced_calls)} calls without a price`,
                    ]
                      .filter(Boolean)
                      .join(" · ")
              }
            />
            <Tile label="Helpful" value={pct(t.thumbs_up, rated)} note={`${n(t.thumbs_down)} 👎 · ${pct(t.gaps, t.answers)} not in sources`} />
          </div>
          <div className="admin-charts">
            <div className="card stack">
              <h3>Answers per day</h3>
              <ColumnChart title="Answers" points={data.series.map((d) => ({ day: d.day, value: d.answers }))} noun={(v) => (v === 1 ? "answer" : "answers")} />
            </div>
            <div className="card stack">
              <h3>AI cost per day (USD)</h3>
              <ColumnChart
                title="Cost (USD)"
                points={data.series.map((d) => ({ day: d.day, value: d.cost_usd }))}
                format={(v) => (v === 0 ? "$0" : v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`)}
                noun={() => "spent"}
                floor={0.01}
              />
            </div>
          </div>
          <div className="card stack">
            <div className="row-between">
              <h3>Top accounts</h3>
              <button className="link-btn" onClick={() => setTab("Accounts")}>All accounts</button>
            </div>
            <AccountsTable accounts={data.accounts.slice(0, 8)} rate={rate} onOpen={(id) => (setAccount(id), setTab("Accounts"))} />
          </div>
        </section>
      )}

      {tab === "Accounts" && (
        <section className="stack">
          {account ? (
            <AccountPanel id={account} days={days} rate={rate} onBack={() => setAccount(null)} onTrace={setTrace} />
          ) : (
            <div className="card">
              <AccountsTable accounts={data.accounts} rate={rate} onOpen={setAccount} />
            </div>
          )}
        </section>
      )}

      {tab === "Problems" && (
        <section className="stack">
          <p className="muted">Answers that failed, were cut off, needed retries, or were written by the backup model. Open one to see its full trace.</p>
          <div className="card table-wrap">
            <table className="data-table admin-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Account · agent</th>
                  <th>What happened</th>
                  <th>Question</th>
                </tr>
              </thead>
              <tbody>
                {data.problems.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">No problems in this period.</td>
                  </tr>
                )}
                {data.problems.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => setTrace(p.id)}>
                    <td className="nowrap">{when(p.created_at)}</td>
                    <td>
                      {p.email}
                      <br />
                      <span className="muted small">{p.agent_name ?? "(deleted agent)"} · {p.channel}</span>
                    </td>
                    <td>
                      <span className={`badge ${p.status === "error" ? "failed" : p.status === "partial" ? "alert" : "processing"}`}>
                        {p.status === "error" ? "failed" : p.status === "partial" ? "cut off" : p.fallback_used ? "backup model" : `${p.attempts} attempts`}
                      </span>
                      <div className="muted small clip">{p.error}</div>
                    </td>
                    <td><div className="clip">{p.question}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "Models & ingestion" && <ModelsAndIngestion data={data} rate={rate} reload={load} />}

      {tab === "Admins" && <Admins />}

      {trace && <TracePanel id={trace} rate={rate} onClose={() => setTrace(null)} />}
    </main>
  );
}

// ---- accounts -----------------------------------------------------------------------------------------
function AccountsTable({ accounts, rate, onOpen }: { accounts: Account[]; rate: number | null; onOpen: (id: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="data-table admin-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Plan · credits this month</th>
            <th className="num">Agents</th>
            <th className="num">Conversations</th>
            <th className="num">Answers</th>
            <th className="num">Failed</th>
            <th className="num">👎</th>
            <th className="num">AI cost</th>
            <th>Last active</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const used = a.credits_limit ? a.credits_used / a.credits_limit : 0;
            return (
              <tr key={a.id} className="clickable" onClick={() => onOpen(a.id)}>
                <td>
                  <button type="button" className="link-btn" onClick={(e) => (e.stopPropagation(), onOpen(a.id))}>
                    {a.email}
                  </button>
                  {a.name && <div className="muted small">{a.name}</div>}
                </td>
                <td>
                  <span className="plan">{a.plan}</span> {n(a.credits_used)} / {n(a.credits_limit)}
                  <div className={`meter small-meter${used >= 0.9 ? " hot" : ""}`} aria-hidden>
                    <div style={{ width: `${Math.min(100, used * 100)}%` }} />
                  </div>
                </td>
                <td className="num">{n(a.agents)}</td>
                <td className="num">{n(a.conversations)}</td>
                <td className="num">{n(a.answers)}</td>
                <td className={`num${a.errors ? " bad" : ""}`}>{n(a.errors)}</td>
                <td className="num">{n(a.thumbs_down)}</td>
                <td className="num nowrap">{usd(a.cost_usd, rate)}</td>
                <td className="nowrap muted">{when(a.last_active)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AccountPanel({ id, days, rate, onBack, onTrace }: { id: string; days: number; rate: number | null; onBack: () => void; onTrace: (id: string) => void }) {
  const [d, setD] = useState<AccountDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<AccountDetail>(`/api/admin/accounts/${id}?days=${days}`).then(setD, (e) => setError(e.message));
  }, [id, days]);
  if (error) return <p className="error-text">{error}</p>;
  if (!d) return <p className="muted">Loading…</p>;
  return (
    <>
      <button className="link-btn" onClick={onBack}>← All accounts</button>
      <div className="card stack">
        <div className="row-between">
          <div>
            <h2 style={{ margin: 0 }}>{d.user.email}</h2>
            <span className="muted small">
              {d.user.name && `${d.user.name} · `}joined {new Date(d.user.created_at).toLocaleDateString("en-IN")} · plan <b>{d.user.plan}</b>
              {d.subscription && ` · subscription ${d.subscription.status}${d.subscription.cancel_at_period_end ? " (cancels at period end)" : ""}`}
            </span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="num">Sources</th>
                <th className="num">Passages</th>
                <th className="num">Q&amp;A</th>
                <th>Channels</th>
                <th className="num">Conversations</th>
                <th className="num">Answers</th>
                <th className="num">Not in sources</th>
                <th className="num">👎</th>
                <th className="num">Leads</th>
                <th className="num">AI cost</th>
              </tr>
            </thead>
            <tbody>
              {d.agents.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td className="num">
                    {n(a.sources)}
                    {a.failed_sources > 0 && <span className="bad"> ({a.failed_sources} failed)</span>}
                  </td>
                  <td className="num">{n(a.passages)}</td>
                  <td className="num">{n(a.qa_answers)}</td>
                  <td className="small">
                    Website{a.allowed_domains ? ` (${a.allowed_domains} sites)` : ""}
                    {a.whatsapp && " · WhatsApp"}
                  </td>
                  <td className="num">{n(a.conversations)}</td>
                  <td className="num">{n(a.answers)}</td>
                  <td className="num">{pct(a.gaps, a.answers)}</td>
                  <td className="num">{n(a.thumbs_down)}</td>
                  <td className="num">{n(a.leads)}</td>
                  <td className="num nowrap">{usd(a.cost_usd, rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card stack">
        <h3>Latest AI calls</h3>
        <CallsTable calls={d.calls} rate={rate} onTrace={onTrace} />
      </div>
    </>
  );
}

function CallsTable({ calls, rate, onTrace }: { calls: CallRow[]; rate: number | null; onTrace: (id: string) => void }) {
  if (!calls.length) return <p className="muted">No AI calls yet.</p>;
  return (
    <div className="table-wrap">
      <table className="data-table admin-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Question</th>
            <th>Result</th>
            <th className="num">First word</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id} className={c.kind === "answer" ? "clickable" : ""} onClick={() => c.kind === "answer" && onTrace(c.id)}>
              <td className="nowrap">{when(c.created_at)}</td>
              <td>{c.agent_name ?? "–"}</td>
              <td><div className="clip">{c.kind === "ingest" ? <span className="muted">Indexing a source</span> : c.question}</div></td>
              <td className="nowrap">
                <span className={`badge ${c.status === "ok" ? "ready" : "failed"}`}>{c.status === "partial" ? "cut off" : c.status}</span>
                {c.fallback_used && <span className="muted small"> backup</span>}
                {c.kind === "answer" && <span className="muted small"> · {c.passages} passages{c.fixes ? ` · ${c.fixes} Q&A` : ""}</span>}
              </td>
              <td className="num">{secs(c.first_token_ms)}</td>
              <td className="num">{compact(c.input_tokens + c.output_tokens)}</td>
              <td className="num nowrap">{usd(c.cost_usd, rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- models & ingestion -------------------------------------------------------------------------------
function ModelsAndIngestion({ data, rate, reload }: { data: Overview; rate: number | null; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const ing = data.ingestion;
  async function reindex() {
    setBusy(true);
    setMsg("");
    try {
      const r = await api<{ sourcesQueued: number; sourcesNotReprocessable: number; qaAnswersReembedded: number }>("/api/admin/reindex", { method: "POST", ...json({}) });
      setMsg(
        `Queued ${r.sourcesQueued} sources and re-embedded ${r.qaAnswersReembedded} Q&A answers.` +
          (r.sourcesNotReprocessable ? ` ${r.sourcesNotReprocessable} sources have no kept content and must be re-added by their owners.` : "")
      );
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="stack">
      <div className="card stack">
        <h3>Models</h3>
        <div className="table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>Use</th>
                <th>Model</th>
                <th className="num">Calls</th>
                <th className="num">Failed</th>
                <th className="num">Input tokens</th>
                <th className="num">Output tokens</th>
                <th className="num">First word (avg)</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => (
                <tr key={`${m.kind}${m.provider}${m.model}`}>
                  <td>{m.kind === "answer" ? "Answers" : "Indexing"}</td>
                  <td>
                    <code>
                      {m.provider}:{m.model}
                    </code>
                  </td>
                  <td className="num">{n(m.calls)}</td>
                  <td className={`num${m.errors ? " bad" : ""}`}>{n(m.errors)}</td>
                  <td className="num">
                    {compact(m.input_tokens)}
                    {m.estimated && <span className="muted" title="Estimated: the provider didn't report usage"> ≈</span>}
                  </td>
                  <td className="num">{compact(m.output_tokens)}</td>
                  <td className="num">{secs(m.avg_first_token_ms)}</td>
                  <td className="num nowrap">{m.unpriced ? <span className="muted">no price</span> : usd(m.cost_usd ?? 0, rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.config.pricesConfigured && <p className="muted small">Set <code>LLM_PRICES</code> (and <code>EMBEDDING_PRICE_PER_MTOK</code>) to turn tokens into costs.</p>}
      </div>

      <div className="card stack">
        <h3>Ingestion</h3>
        <div className="tiles">
          <Tile label="Waiting" value={n(ing.queued)} note={ing.retrying ? `${ing.retrying} waiting to retry` : undefined} />
          <Tile label="Running now" value={n(ing.running)} />
          <Tile label="Ready sources" value={n(ing.ready)} note={`${compact(ing.passages)} passages`} />
          <Tile label="Failed sources" value={n(ing.failed)} tone={ing.failed ? "bad" : undefined} />
        </div>
        {ing.failedSources.length > 0 && (
          <div className="table-wrap">
            <table className="data-table admin-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Account · agent</th>
                  <th>Source</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {ing.failedSources.map((s) => (
                  <tr key={s.id}>
                    <td className="nowrap">{when(s.updated_at)}</td>
                    <td>
                      {s.email}
                      <br />
                      <span className="muted small">{s.agent_name}</span>
                    </td>
                    <td>
                      {s.title} <span className="muted small">({s.type}, {s.attempts} attempts)</span>
                    </td>
                    <td className="muted small"><div className="clip">{s.error}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card stack">
        <h3>Embedding model</h3>
        <p className="muted">
          {n(data.embedding.total)} passages · {n(data.embedding.stale)} made with an older embedding model (not searchable until re-indexed) ·{" "}
          {n(data.embedding.untracked)} from before models were tracked.
        </p>
        {data.embedding.stale > 0 && (
          <div>
            <button className="btn" disabled={busy} onClick={reindex}>
              {busy ? "Re-indexing…" : `Re-index with ${data.config.embedding}`}
            </button>
          </div>
        )}
        {msg && <p className="ok-text">{msg}</p>}
      </div>
    </section>
  );
}

// ---- answer trace -------------------------------------------------------------------------------------
function TracePanel({ id, rate, onClose }: { id: string; rate: number | null; onClose: () => void }) {
  const [tr, setTr] = useState<Trace | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setTr(null);
    api<Trace>(`/api/admin/calls/${id}`).then(setTr, (e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const c = tr?.call;
  return (
    <div className="trace-backdrop" onClick={onClose}>
      <aside className="trace" role="dialog" aria-label="Answer trace" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Answer trace</h2>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        {error && <p className="error-text">{error}</p>}
        {!tr && !error && <p className="muted">Loading…</p>}
        {tr && c && (
          <div className="stack">
            <p className="muted small">
              {when(c.created_at)} · {c.email} · {c.agent_name ?? "(deleted agent)"} · {c.channel}
            </p>
            <dl className="trace-facts">
              <div><dt>Result</dt><dd><span className={`badge ${c.status === "ok" ? "ready" : "failed"}`}>{c.status === "partial" ? "cut off" : c.status}</span>{tr.feedback === 1 ? " 👍" : tr.feedback === -1 ? " 👎" : ""}</dd></div>
              <div><dt>Model</dt><dd><code>{c.provider}:{c.model}</code>{c.fallback_used && " (backup)"}</dd></div>
              <div><dt>Attempts</dt><dd>{c.attempts}</dd></div>
              <div><dt>First word · total</dt><dd>{secs(c.first_token_ms)} · {secs(c.total_ms)}</dd></div>
              <div><dt>Tokens in · out</dt><dd>{n(c.input_tokens)} · {n(c.output_tokens)}{c.tokens_estimated && " (estimated)"}</dd></div>
              <div><dt>Cost</dt><dd>{usd(c.cost_usd, rate)}</dd></div>
              <div><dt>Prompt version</dt><dd>{c.prompt_version ?? "–"}</dd></div>
            </dl>
            {c.error && <p className="error-text small trace-error">{c.error}</p>}
            <div>
              <p className="label">Question</p>
              <p className="msg">{c.question}</p>
              {c.search_query && (
                <p className="muted small">
                  Searched for: “{c.search_query}”{c.rewrite_model && ` (rewritten by ${c.rewrite_model})`}
                </p>
              )}
            </div>
            <div>
              <p className="label">Answer</p>
              <p className="msg">{tr.answer ?? <span className="muted">(no answer was saved)</span>}</p>
            </div>
            {tr.fixes.length > 0 && (
              <div>
                <p className="label">Q&amp;A answers that matched</p>
                {tr.fixes.map((f) => (
                  <div key={f.id} className="passage">
                    <div className="row-between">
                      <strong>{f.question}</strong>
                      <Score v={f.score} />
                    </div>
                    <p className="msg small">{f.answer ?? <span className="muted">(since deleted)</span>}</p>
                  </div>
                ))}
              </div>
            )}
            <div>
              <p className="label">Passages given to the model ({tr.retrieved.length})</p>
              {tr.retrieved.length === 0 && <p className="muted small">None scored above the minimum: the model had nothing from the sources.</p>}
              {tr.retrieved.map((r, i) => (
                <div key={r.chunkId} className="passage">
                  <div className="row-between">
                    <strong>
                      [{i + 1}] {r.title}
                    </strong>
                    <span className="row-form small muted">
                      {r.via && <span title="Which search found it">{r.via === "both" ? "meaning + words" : r.via === "keyword" ? "words" : "meaning"}</span>}
                      <Score v={r.score} />
                    </span>
                  </div>
                  {r.url && <a className="small" href={r.url} target="_blank" rel="noopener noreferrer">{r.url}</a>}
                  <p className="msg small">{r.content ?? <span className="muted">(passage since deleted or re-indexed)</span>}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function Score({ v }: { v: number }) {
  return (
    <span className="score" title="Similarity to the question (0 to 1)">
      <span className="score-bar" aria-hidden>
        <span style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} />
      </span>
      {v.toFixed(2)}
    </span>
  );
}
