"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import FixForm from "./FixForm";
import { ColumnChart, Tile } from "./charts";

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
const CHANNEL: Record<string, string> = { widget: "Website", whatsapp: "WhatsApp" };

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
        <ColumnChart title="Conversations" points={data.series.map((d) => ({ day: d.day, value: d.conversations }))} noun={(n) => (n === 1 ? "conversation" : "conversations")} />
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
