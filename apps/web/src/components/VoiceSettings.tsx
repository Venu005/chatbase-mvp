"use client";

import { useCallback, useEffect, useState } from "react";
import { api, json } from "@chatbase/core/client";
import { VOICE_LANGUAGES, VOICE_SPEAKERS } from "@chatbase/core/voice/options";

type VoiceAgent = {
  id: string;
  voice_enabled: boolean;
  voice_language: string;
  voice_speaker: string;
  voice_greeting: string;
  voice_transfer_number: string | null;
  welcome_message: string;
  handoff_enabled: boolean;
};
type Setup = { gateway: string; plivoAnswerUrl: string; exotelStreamUrl: string } | null;

/** The agent's Voice tab: website voice mode, the voice itself, and phone-call setup (Plivo / Exotel). */
export default function VoiceSettings({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<VoiceAgent | null>(null);
  const [setup, setSetup] = useState<Setup>(null);
  const [f, setF] = useState({ voiceEnabled: false, voiceLanguage: "en-IN", voiceSpeaker: "anushka", voiceGreeting: "", voiceTransferNumber: "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const r = await api<{ agent: VoiceAgent; voice: Setup }>(`/api/agents/${agentId}`);
    setAgent(r.agent);
    setSetup(r.voice);
    setF({
      voiceEnabled: r.agent.voice_enabled,
      voiceLanguage: r.agent.voice_language,
      voiceSpeaker: r.agent.voice_speaker,
      voiceGreeting: r.agent.voice_greeting,
      voiceTransferNumber: r.agent.voice_transfer_number ?? "",
    });
  }, [agentId]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);

  async function save(body: Record<string, unknown>, done = "Saved") {
    setError("");
    setMsg("");
    try {
      await api(`/api/agents/${agentId}`, { method: "PATCH", ...json(body) });
      setMsg(done);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!agent) return <p className="muted">{error || "Loading…"}</p>;
  const copy = (s: string) => navigator.clipboard?.writeText(s);
  return (
    <div className="stack">
      <form className="card stack" onSubmit={(e) => (e.preventDefault(), void save(f))}>
        <h3>Voice</h3>
        <p className="muted">
          Customers can talk to your assistant instead of typing, on your website and on phone calls. It understands English, Hindi,
          Hinglish and 9 other Indian languages, answers from the same sources, and replies out loud. Customers can interrupt it
          at any time. Each spoken answer uses one message credit.
        </p>
        <label className="check">
          <input type="checkbox" checked={f.voiceEnabled} onChange={(e) => setF({ ...f, voiceEnabled: e.target.checked })} />
          Show a microphone button in the website chat
        </label>
        <div className="row-form">
          <label>
            Voice
            <select value={f.voiceSpeaker} onChange={(e) => setF({ ...f, voiceSpeaker: e.target.value })}>
              {VOICE_SPEAKERS.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label>
            Language when it can&apos;t tell
            <select value={f.voiceLanguage} onChange={(e) => setF({ ...f, voiceLanguage: e.target.value })}>
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          First thing it says
          <input value={f.voiceGreeting} maxLength={300} onChange={(e) => setF({ ...f, voiceGreeting: e.target.value })} placeholder={agent.welcome_message} />
        </label>
        <label>
          Phone calls: transfer to this number when a caller asks for a person
          <input type="tel" value={f.voiceTransferNumber} maxLength={20} onChange={(e) => setF({ ...f, voiceTransferNumber: e.target.value })} placeholder="+919876543210" />
        </label>
        {!agent.handoff_enabled && <span className="muted small">Turn on “Let customers ask for a human” in Settings for transfers to work.</span>}
        {error && <p className="error-text">{error}</p>}
        {msg && <p className="ok-text">{msg}</p>}
        <div>
          <button className="btn">Save</button>
        </div>
      </form>

      <section className="card stack">
        <h3>Phone calls</h3>
        {!setup ? (
          <p className="muted">
            Phone calls and website voice need the voice service. Ask whoever runs this platform to start it and set <code>VOICE_PUBLIC_URL</code>.
          </p>
        ) : (
          <>
            <p className="muted">
              Connect a phone number from Plivo or Exotel so callers talk to this assistant. These addresses contain a secret: don&apos;t
              share them.
            </p>
            <p className="label">Plivo: set the number&apos;s application “Answer URL” (POST) to</p>
            <pre className="code">{setup.plivoAnswerUrl}</pre>
            <button type="button" className="btn ghost" onClick={() => copy(setup.plivoAnswerUrl)}>Copy</button>
            <p className="label">Exotel: in your call flow, add a Voicebot applet with this URL (put a Connect applet after it for transfers)</p>
            <pre className="code">{setup.exotelStreamUrl}</pre>
            <button type="button" className="btn ghost" onClick={() => copy(setup.exotelStreamUrl)}>Copy</button>
            <div>
              <button
                type="button"
                className="link-btn"
                onClick={() => window.confirm("Make new addresses? The current ones stop working at once.") && void save({ resetVoiceToken: true }, "New addresses made. Update them in Plivo / Exotel.")}
              >
                Make new addresses
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
