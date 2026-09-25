"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import FixForm from "./FixForm";

type Data = {
  days: number;
  totals: {
    conversations: number;
    handoffs: number;
    visitor_messages: number;
    answers: number;
    gaps: number;
    thumbs_up: number;
    thumbs_down: number;
    team_replies: number;
    avg_latency_ms: number;
  };
  series: { day: string; conversations: number }[];
  channels: { channel: string; conversations: number }[];
  gaps: { question: string; times: number; last_asked: string }[];
  disliked: { message_id: string; question: string | null; answer: string; times: number; last_at: string; fixed: boolean }[];
};

const fmt = (n: number) => n.toLocaleString("en-IN");
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const CHANNEL: Record<string, string> = { widget: "Website", whatsapp: "WhatsApp" };

/** Clean axis maximum (1, 2, 5 × 10ⁿ) at or above the largest value. */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

/** Single-series column chart: conversations per day. Hover (or focus) a day for its exact count. */
function DailyChart({ series }: { series: Data["series"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...series.map((d) => d.conversations)));
  const h = hover === null ? null : series[hover];
  return (
    <figure className="chart" aria-label="Conversations per day">
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        {[1, 0.5, 0].map((f) => (
          <div key={f} className="chart-grid" style={{ bottom: `${f * 100}%` }}>
            <span>{fmt(max * f)}</span>
          </div>
        ))}
        <div className="chart-cols">
          {series.map((d, i) => (
            <button
              key={d.day}
              type="button"
              className={`chart-col${hover === i ? " on" : ""}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${dayLabel(d.day)}: ${d.conversations} conversations`}
            >
              <span style={{ height: `${(d.conversations / max) * 100}%` }} />
            </button>
          ))}
        </div>
        {h && (
          <div className="chart-tip" style={{ left: `${((hover! + 0.5) / series.length) * 100}%` }} role="status">
            <span className="muted">{dayLabel(h.day)}</span> <strong>{fmt(h.conversations)}</strong> conversation{h.conversations === 1 ? "" : "s"}
          </div>
        )}
      </div>
      <div className="chart-x muted small">
        <span>{dayLabel(series[0].day)}</span>
        <span>{dayLabel(series[series.length - 1].day)}</span>
      </div>
      <details className="small">
        <summary className="muted">Show as table</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Conversations</th>
            </tr>
          </thead>
          <tbody>
            {series.map((d) => (
              <tr key={d.day}>
                <td>{dayLabel(d.day)}</td>
                <td>{fmt(d.conversations)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export default function Analytics({ agentId }: { agentId: string }) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [fixing, setFixing] = useState<string | null>(null); // key of the gap / 👎 row being answered

  const load = useCallback(async () => {
    try {
      setData(await api<Data>(`/api/agents/${agentId}/analytics?days=${days}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [agentId, days]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const t = data.totals;
  const rated = t.thumbs_up + t.thumbs_down;
  const saved = () => {
    setFixing(null);
    void load();
  };

  return (
    <section className="stack">
      <div className="seg" role="group" aria-label="Period">
        {([7, 30, 90] as const).map((d) => (
          <button type="button" key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>
            Last {d} days
          </button>
        ))}
      </div>

      <div className="tiles">
        <Tile label="Conversations" value={fmt(t.conversations)} note={data.channels.map((c) => `${CHANNEL[c.channel] ?? c.channel} ${fmt(c.conversations)}`).join(" · ") || undefined} />
        <Tile label="Answers by the assistant" value={fmt(t.answers)} note={t.avg_latency_ms ? `avg. ${(t.avg_latency_ms / 1000).toFixed(1)}s to answer` : undefined} />
        <Tile label="Helpful (of rated answers)" value={pct(t.thumbs_up, rated)} note={`${fmt(t.thumbs_up)} 👍 · ${fmt(t.thumbs_down)} 👎`} />
        <Tile label="Not found in your sources" value={pct(t.gaps, t.answers)} note={`${fmt(t.gaps)} answers`} />
        <Tile label="Asked for a person" value={fmt(t.handoffs)} note={`${fmt(t.team_replies)} replies by your team`} />
      </div>

      <div className="card stack">
        <h3>Conversations per day</h3>
        <DailyChart series={data.series} />
      </div>

      <div className="card stack">
        <h3>Knowledge gaps</h3>
        <p className="muted">Questions your sources had no answer for, most asked first. Add an answer and the assistant uses it from now on.</p>
        {data.gaps.length === 0 && <p className="muted">None in this period.</p>}
        <ul className="list plain">
          {data.gaps.map((g) => (
            <li key={g.question}>
              <div className="row-between">
                <span>
                  <strong>{g.question}</strong>{" "}
                  <span className="muted small">
                    asked {g.times}× · last {new Date(g.last_asked).toLocaleDateString("en-IN")}
                  </span>
                </span>
                {fixing !== `g:${g.question}` && (
                  <button className="link-btn" onClick={() => setFixing(`g:${g.question}`)}>
                    Add answer
                  </button>
                )}
              </div>
              {fixing === `g:${g.question}` && <FixForm agentId={agentId} initial={{ question: g.question, answer: "" }} onCancel={() => setFixing(null)} onSaved={saved} />}
            </li>
          ))}
        </ul>
      </div>

      <div className="card stack">
        <h3>Answers marked 👎</h3>
        <p className="muted">Grouped by question, most disliked first. Write the answer you want, and the assistant uses it from now on.</p>
        {data.disliked.length === 0 && <p className="muted">None in this period.</p>}
        <ul className="list plain">
          {data.disliked.map((d) => (
            <li key={d.message_id}>
              <div className="row-between">
                <span>
                  <strong>
                    {d.question ?? "(no question)"} <span className="muted small">👎 {d.times}×</span>
                  </strong>
                  <span className="msg muted small">{d.answer.slice(0, 300)}</span>
                </span>
                {d.fixed ? (
                  <span className="small ok-text">✓ Fixed</span>
                ) : (
                  fixing !== `d:${d.message_id}` && (
                    <button className="link-btn" onClick={() => setFixing(`d:${d.message_id}`)}>
                      Fix this answer
                    </button>
                  )
                )}
              </div>
              {fixing === `d:${d.message_id}` && (
                <FixForm
                  agentId={agentId}
                  initial={{ question: d.question ?? "", answer: d.answer.replace(/\s*\[\d{1,2}\]/g, ""), messageId: Number(d.message_id) }}
                  onCancel={() => setFixing(null)}
                  onSaved={saved}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
