"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

type Lead = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  channel: string;
  source: "form" | "handoff" | "whatsapp";
  created_at: string;
  conversation_id: string | null;
  first_message: string | null;
};

const VIA = { form: "Lead form", handoff: "Asked for a person", whatsapp: "WhatsApp" } as const;

export default function Leads({
  agentId,
  leadMode,
  openChat,
}: {
  agentId: string;
  leadMode: "off" | "after_first_answer" | "before_chat";
  openChat: (conversationId: string) => void;
}) {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setLeads((await api<{ leads: Lead[] }>(`/api/agents/${agentId}/leads`)).leads);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(l: Lead) {
    if (!window.confirm(`Delete the lead ${l.name ?? l.email ?? l.phone}? The conversation stays in Chats.`)) return;
    await api(`/api/agents/${agentId}/leads/${l.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    await load();
  }

  if (error) return <p className="error-text">{error}</p>;
  if (!leads) return <p className="muted">Loading…</p>;

  return (
    <section className="stack">
      <div className="row-between">
        <p className="muted" style={{ margin: 0 }}>
          {leadMode === "off"
            ? "The website form is off (turn it on in Settings → Collect leads). WhatsApp customers and visitors who leave contact details when asking for a person still appear here."
            : "People who left their details in the chat, on WhatsApp, or when asking for a person."}
        </p>
        {leads.length > 0 && (
          <a className="btn ghost" href={`/api/agents/${agentId}/leads?format=csv`} download>
            Download CSV
          </a>
        )}
      </div>
      {leads.length === 0 ? (
        <p className="muted">No leads yet.</p>
      ) : (
        <div className="card table-wrap">
          <table className="data-table leads">
            <thead>
              <tr>
                <th>Name</th>
                <th>Contact</th>
                <th>Via</th>
                <th>First question</th>
                <th>Date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td>{l.name ?? <span className="muted">-</span>}</td>
                  <td>
                    {l.phone && <a href={`tel:${l.phone}`}>{l.phone}</a>}
                    {l.phone && l.email && <br />}
                    {l.email && <a href={`mailto:${l.email}`}>{l.email}</a>}
                  </td>
                  <td>{VIA[l.source]}</td>
                  <td className="muted">
                    {l.conversation_id ? (
                      <button type="button" className="link-btn small" onClick={() => openChat(l.conversation_id!)}>
                        {(l.first_message ?? "Open chat").slice(0, 60)}
                      </button>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>{new Date(l.created_at).toLocaleDateString("en-IN")}</td>
                  <td>
                    <button className="link-btn small" onClick={() => remove(l)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
