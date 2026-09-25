"use client";

import { useState } from "react";
import { api, json } from "@/lib/client";

/** Create (with `initial.messageId` from the inbox, or none) or edit (`fixId`) an owner Q&A answer. */
export default function FixForm({
  agentId,
  fixId,
  initial,
  hint,
  onSaved,
  onCancel,
}: {
  agentId: string;
  fixId?: string;
  initial: { question: string; answer: string; messageId?: number };
  hint?: string;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [question, setQuestion] = useState(initial.question);
  const [answer, setAnswer] = useState(initial.answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (fixId) await api(`/api/agents/${agentId}/fixes/${fixId}`, { method: "PATCH", ...json({ question, answer }) });
      else await api(`/api/agents/${agentId}/fixes`, { method: "POST", ...json({ question, answer, messageId: initial.messageId }) });
      if (!fixId) {
        setQuestion("");
        setAnswer("");
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="fix-form stack" onSubmit={save}>
      <label>
        Customer question
        <input value={question} onChange={(e) => setQuestion(e.target.value)} required maxLength={500} placeholder="e.g. Do you deliver on Sundays?" />
      </label>
      <label>
        Correct answer
        <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} required maxLength={4000} placeholder="e.g. Yes, in Bengaluru only, between 10am and 2pm." />
      </label>
      {hint && <span className="muted small">{hint}</span>}
      {error && <span className="error-text">{error}</span>}
      <span className="row-form">
        <button className="btn" disabled={busy || question.trim().length < 3 || !answer.trim()}>
          {busy ? "Saving…" : "Save answer"}
        </button>
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </span>
    </form>
  );
}
