"use client";

import { useEffect, useRef, useState } from "react";

type Citation = { n: number; title: string; url: string | null };
type Msg = { role: "user" | "assistant" | "human"; content: string; citations?: Citation[]; error?: boolean };
type Remote = { id: number; role: "user" | "assistant" | "human"; content: string; citations?: Citation[] };

function newId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function loadSession(key: string): string {
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = newId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return newId(); // storage blocked (private mode / iframe restrictions): session lasts until reload
  }
}

export default function ChatBox({
  agentId,
  welcome,
  color = "#4f46e5",
  channel = "widget",
  handoffEnabled = false,
}: {
  agentId: string;
  welcome: string;
  color?: string;
  channel?: "widget" | "playground";
  /** Show the "Talk to a human" link (website widget only). */
  handoffEnabled?: boolean;
}) {
  const storageKey = `cb_session_${channel}_${agentId}`;
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", content: welcome }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"bot" | "human">("bot");
  const [contact, setContact] = useState("");
  const [contactState, setContactState] = useState<"idle" | "saving" | "saved">("idle");
  const [notice, setNotice] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const lastHuman = useRef(0); // highest owner-message id already shown

  useEffect(() => {
    setSessionId(loadSession(storageKey));
  }, [storageKey]);
  useEffect(() => {
    // Block body on purpose: an effect must return nothing (or a cleanup function), never the result of a call.
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Website widget: restore the conversation after a page reload (it also tells us if a person has taken over).
  useEffect(() => {
    if (channel !== "widget" || !sessionId) return;
    let cancelled = false;
    fetch(`/api/chat/${agentId}/messages?sessionId=${sessionId}&all=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { mode: "bot" | "human"; hasContact?: boolean; messages: Remote[] } | null) => {
        if (cancelled || !j) return;
        if (j.hasContact) setContactState("saved");
        if (j.messages.length) {
          setMessages(j.messages.map((m) => ({ role: m.role, content: m.content, citations: m.role === "assistant" && m.citations?.length ? m.citations : undefined })));
          lastHuman.current = Math.max(0, ...j.messages.filter((m) => m.role === "human").map((m) => m.id));
        }
        setMode(j.mode);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentId, channel, sessionId]);

  // While a person is handling the chat, poll for their replies (and notice if they hand back to the assistant).
  useEffect(() => {
    if (channel !== "widget" || mode !== "human" || !sessionId) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/chat/${agentId}/messages?sessionId=${sessionId}&after=${lastHuman.current}`);
        if (!r.ok) return;
        const j = (await r.json()) as { mode: "bot" | "human"; messages: Remote[] };
        if (j.messages.length) {
          lastHuman.current = Math.max(lastHuman.current, ...j.messages.map((m) => m.id));
          setMessages((ms) => [...ms, ...j.messages.map((m) => ({ role: "human" as const, content: m.content }))]);
        }
        if (j.mode === "bot") setMode("bot");
      } catch {
        /* offline: try again on the next tick */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [agentId, channel, mode, sessionId]);

  async function talkToHuman() {
    if (!sessionId) return;
    setNotice("");
    try {
      const r = await fetch(`/api/chat/${agentId}/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't reach the team. Please try again.");
      setMode("human");
      if (j.notice) setMessages((ms) => [...ms, { role: "assistant", content: j.notice }]);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function saveContact(e: React.FormEvent) {
    e.preventDefault();
    if (!contact.trim() || !sessionId) return;
    setContactState("saving");
    setNotice("");
    try {
      const r = await fetch(`/api/chat/${agentId}/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, contact }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save that. Please try again.");
      setContactState("saved");
    } catch (err) {
      setNotice((err as Error).message);
      setContactState("idle");
    }
  }

  function reset() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    setSessionId(loadSession(storageKey));
    setMessages([{ role: "assistant", content: welcome }]);
    setMode("bot");
    lastHuman.current = 0;
  }

  const patchLast = (fn: (m: Msg) => Msg) => setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !sessionId) return;
    setInput("");
    setBusy(true);
    setMessages((ms) => [...ms, { role: "user", content: text }, { role: "assistant", content: "" }]);
    try {
      const res = await fetch(`/api/chat/${agentId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, sessionId, channel }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Something went wrong. Please try again.");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!l) continue;
          const ev = JSON.parse(l);
          if (ev.type === "delta") patchLast((m) => ({ ...m, content: m.content + ev.text }));
          else if (ev.type === "done") patchLast((m) => ({ ...m, citations: ev.citations }));
          else if (ev.type === "handoff") {
            // A person is handling this chat: no bot reply. Show the notice (first time only) instead of the empty bubble.
            setMode("human");
            setMessages((ms) => (ev.notice ? ms.map((m, i) => (i === ms.length - 1 ? { ...m, content: ev.notice } : m)) : ms.slice(0, -1)));
          }
          else if (ev.type === "error") patchLast((m) => ({ ...m, content: m.content || ev.message, error: true }));
        }
      }
    } catch (err) {
      patchLast((m) => ({ ...m, content: m.content || (err as Error).message, error: true }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-scroll">
        {messages.map((m, i) => (
          <div key={i} className={`bubble-row ${m.role}`}>
            <div className={`bubble ${m.role}${m.error ? " error" : ""}`} style={m.role === "user" ? { background: color } : undefined}>
              {m.role === "human" && <span className="human-label">Team</span>}
              {m.content || (busy && i === messages.length - 1 ? <span className="typing">●●●</span> : "")}
              {!!m.citations?.length && (
                <div className="cites">
                  {m.citations.map((c) =>
                    c.url ? (
                      <a key={c.n} href={c.url} target="_blank" rel="noopener noreferrer">
                        [{c.n}] {c.title}
                      </a>
                    ) : (
                      <span key={c.n}>
                        [{c.n}] {c.title}
                      </span>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {channel === "widget" && mode === "human" && contactState !== "saved" && (
        <form className="handoff-contact" onSubmit={saveContact}>
          <span className="small muted">Leave a phone number or e-mail so the team can reach you if you close this window (optional).</span>
          <div className="row-form">
            <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Phone or e-mail" maxLength={200} aria-label="Phone or e-mail" />
            <button className="btn ghost" disabled={contactState === "saving" || contact.trim().length < 3}>Save</button>
          </div>
        </form>
      )}
      {channel === "widget" && mode === "human" && contactState === "saved" && <p className="ok-text small handoff-contact">Thanks - the team has your details.</p>}
      {notice && <p className="error-text small handoff-contact">{notice}</p>}
      {channel === "widget" && handoffEnabled && mode === "bot" && (
        <button type="button" className="link-btn talk-human" onClick={talkToHuman}>
          Talk to a human
        </button>
      )}
      <form className="chat-input" onSubmit={send}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={mode === "human" ? "Message our team…" : "Type your question…"} maxLength={2000} aria-label="Message" />
        <button type="submit" disabled={busy || !input.trim()} style={{ background: color }}>
          Send
        </button>
      </form>
      {channel === "playground" && (
        <button type="button" className="link-btn" onClick={reset}>
          Start a new chat
        </button>
      )}
    </div>
  );
}
