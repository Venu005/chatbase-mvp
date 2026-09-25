"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, json } from "@/lib/client";
import ChatBox from "./ChatBox";

type Agent = {
  id: string;
  name: string;
  instructions: string;
  welcome_message: string;
  brand_color: string;
  handoff_enabled: boolean;
  handoff_message: string;
  notify_email: boolean;
  allowed_domains: string[];
};
type Source = { id: string; type: string; title: string; url: string | null; status: "processing" | "ready" | "failed"; error: string | null; char_count: number; chunk_count: number };
type Convo = {
  id: string;
  channel: string;
  updated_at: string;
  message_count: number;
  first_message: string | null;
  last_visitor_message: string | null;
  mode: "bot" | "human";
  needs_reply: boolean;
  contact: string | null;
  handoff_reason: string | null;
};
type Message = { id: number; role: string; content: string; created_at: string };

const TABS = ["Sources", "Playground", "Settings", "Embed", "WhatsApp", "Chats"] as const;
type Tab = (typeof TABS)[number];

export default function AgentWorkspace({ id }: { id: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [tab, setTab] = useState<Tab>("Sources");
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0); // bump to remount the playground after settings change
  const [convos, setConvos] = useState<Convo[] | null>(null);

  const load = useCallback(async () => {
    try {
      setAgent((await api<{ agent: Agent }>(`/api/agents/${id}`)).agent);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  // Conversations are polled here (not just in the Chats tab) so the tab can show how many customers are waiting.
  const loadConvos = useCallback(async () => {
    try {
      setConvos((await api<{ conversations: Convo[] }>(`/api/agents/${id}/conversations`)).conversations);
    } catch {
      setConvos((c) => c ?? []);
    }
  }, [id]);
  useEffect(() => {
    void loadConvos();
    const t = setInterval(loadConvos, 10_000);
    return () => clearInterval(t);
  }, [loadConvos]);

  // Deep link from the notification e-mail: /dashboard/agents/<id>?c=<conversation>#chats
  useEffect(() => {
    const h = window.location.hash.slice(1).toLowerCase();
    const found = TABS.find((t) => t.toLowerCase() === h);
    if (found) setTab(found);
  }, []);

  const waiting = convos?.filter((c) => c.needs_reply).length ?? 0;

  if (error) return <main className="page"><p className="error-text">{error}</p><Link href="/dashboard">← Back</Link></main>;
  if (!agent) return <main className="page"><p className="muted">Loading…</p></main>;

  return (
    <main className="page">
      <Link href="/dashboard" className="muted">← All agents</Link>
      <h1>{agent.name}</h1>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
            {t === "Chats" && waiting > 0 && <span className="badge alert" style={{ marginLeft: 6 }}>{waiting} waiting</span>}
          </button>
        ))}
      </nav>
      {tab === "Sources" && <SourcesTab agentId={id} />}
      {tab === "Playground" && (
        <div className="card playground">
          <ChatBox key={version} agentId={id} welcome={agent.welcome_message} color={agent.brand_color} channel="playground" />
        </div>
      )}
      {tab === "Settings" && (
        <SettingsTab
          agent={agent}
          onSaved={() => {
            setVersion((v) => v + 1);
            void load();
          }}
        />
      )}
      {tab === "Embed" && <EmbedTab agent={agent} onSaved={load} />}
      {tab === "WhatsApp" && <WhatsAppTab agentId={id} />}
      {tab === "Chats" && <ChatsTab agentId={id} convos={convos} refresh={loadConvos} handoffEnabled={agent.handoff_enabled} />}
    </main>
  );
}

// ---------------------------------------------------------------------------
function SourcesTab({ agentId }: { agentId: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"url" | "file" | "text">("url");
  const [url, setUrl] = useState("");
  const [pages, setPages] = useState(1);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  const load = useCallback(async () => {
    try {
      setSources((await api<{ sources: Source[] }>(`/api/agents/${agentId}/sources`)).sources);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);

  const processing = sources.some((s) => s.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [processing, load]);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "url") await api(`/api/agents/${agentId}/sources`, { method: "POST", ...json({ type: "url", url, crawlPages: pages }) });
      else if (mode === "text") await api(`/api/agents/${agentId}/sources`, { method: "POST", ...json({ type: "text", title, text }) });
      else {
        const file = new FormData(e.currentTarget).get("file");
        if (!(file instanceof File) || !file.size) throw new Error("Choose a file first");
        const fd = new FormData();
        fd.set("file", file);
        await api(`/api/agents/${agentId}/sources`, { method: "POST", body: fd });
      }
      setUrl("");
      setTitle("");
      setText("");
      (e.target as HTMLFormElement).reset?.();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry(sid: string) {
    setError("");
    await api(`/api/agents/${agentId}/sources/${sid}`, { method: "POST" }).catch((e) => setError(e.message));
    await load();
  }

  async function remove(sid: string) {
    if (!window.confirm("Remove this source? The agent will forget it.")) return;
    await api(`/api/agents/${agentId}/sources/${sid}`, { method: "DELETE" }).catch((e) => setError(e.message));
    await load();
  }

  return (
    <section>
      <form className="card stack" onSubmit={add}>
        <div className="seg">
          {(["url", "file", "text"] as const).map((m) => (
            <button type="button" key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {m === "url" ? "Website" : m === "file" ? "File" : "Text / FAQ"}
            </button>
          ))}
        </div>
        {mode === "url" && (
          <div className="row-form">
            <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourbusiness.in/faq" />
            <select value={pages} onChange={(e) => setPages(Number(e.target.value))} aria-label="Pages to read">
              <option value={1}>This page only</option>
              <option value={5}>Up to 5 pages</option>
              <option value={10}>Up to 10 pages</option>
              <option value={20}>Up to 20 pages</option>
            </select>
          </div>
        )}
        {mode === "file" && <input type="file" name="file" accept=".pdf,.txt,.md,.csv" />}
        {mode === "text" && (
          <>
            <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Refund policy" maxLength={120} />
            <textarea required rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste your FAQ, policies, product details…" />
          </>
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? "Adding…" : "Add source"}</button>
      </form>

      <ul className="list">
        {sources.length === 0 && <li className="muted">No sources yet. Add your website, a PDF, or paste your FAQ so the agent can answer from it.</li>}
        {sources.map((s) => (
          <li key={s.id} className="card source">
            <div>
              <strong>{s.title}</strong>
              <div className="muted small">
                {s.type.toUpperCase()}
                {s.status === "ready" && ` · ${s.chunk_count} passages`}
                {s.status === "failed" && s.error && ` · ${s.error}`}
              </div>
            </div>
            <span className={`badge ${s.status}`}>{s.status}</span>
            {s.status === "failed" && s.type === "url" && (
              <button className="link-btn" onClick={() => retry(s.id)}>Retry</button>
            )}
            <button className="link-btn" onClick={() => remove(s.id)}>Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
function SettingsTab({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const [f, setF] = useState({
    name: agent.name,
    instructions: agent.instructions,
    welcomeMessage: agent.welcome_message,
    brandColor: agent.brand_color,
    handoffEnabled: agent.handoff_enabled,
    handoffMessage: agent.handoff_message,
    notifyEmail: agent.notify_email,
  });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMsg("");
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", ...json(f) });
      setMsg("Saved");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function del() {
    if (!window.confirm(`Delete “${agent.name}” and all of its data? This cannot be undone.`)) return;
    await api(`/api/agents/${agent.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    window.location.href = "/dashboard";
  }

  return (
    <form className="card stack" onSubmit={save}>
      <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} /></label>
      <label>
        Instructions
        <textarea rows={6} value={f.instructions} maxLength={4000} onChange={(e) => setF({ ...f, instructions: e.target.value })}
          placeholder="Tone, business name, what to do when you can't answer (e.g. “share our WhatsApp number +91…”), languages to support…" />
      </label>
      <label>Welcome message<input value={f.welcomeMessage} onChange={(e) => setF({ ...f, welcomeMessage: e.target.value })} required maxLength={300} /></label>
      <label>Brand colour<input type="color" value={f.brandColor} onChange={(e) => setF({ ...f, brandColor: e.target.value })} /></label>
      <h3>Talking to a person</h3>
      <label className="check">
        <input type="checkbox" checked={f.handoffEnabled} onChange={(e) => setF({ ...f, handoffEnabled: e.target.checked })} />
        Let customers ask for a human (website “Talk to a human” link, or typing “human”, “agent”, “insaan se baat karni hai” on any channel)
      </label>
      {f.handoffEnabled && (
        <>
          <label>
            What the customer sees when they ask for a person
            <input value={f.handoffMessage} onChange={(e) => setF({ ...f, handoffMessage: e.target.value })} required maxLength={300} />
          </label>
          <label className="check">
            <input type="checkbox" checked={f.notifyEmail} onChange={(e) => setF({ ...f, notifyEmail: e.target.checked })} />
            E-mail me when a customer is waiting for a reply
          </label>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
      {msg && <p className="ok-text">{msg}</p>}
      <div className="row-form">
        <button className="btn">Save changes</button>
        <button type="button" className="btn danger" onClick={del}>Delete agent</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
function EmbedTab({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const agentId = agent.id;
  const [origin, setOrigin] = useState("");
  const [domains, setDomains] = useState(agent.allowed_domains.join("\n"));
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  async function saveDomains(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMsg("");
    try {
      await api(`/api/agents/${agentId}`, { method: "PATCH", ...json({ allowedDomains: domains.split(/[\n,]+/) }) });
      setMsg("Saved");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const snippet = `<script src="${origin}/widget.js" data-agent-id="${agentId}" defer></script>`;
  return (
    <section className="card stack">
      <h3>Add the chat bubble to your website</h3>
      <p className="muted">Paste this just before the closing &lt;/body&gt; tag of your site (works with Shopify, WordPress, Wix, custom sites).</p>
      <pre className="code">{snippet}</pre>
      <button className="btn" onClick={() => navigator.clipboard?.writeText(snippet)}>Copy snippet</button>
      <p className="muted">Or share the full-page chat link: <a href={`/embed/${agentId}`} target="_blank" rel="noopener noreferrer">{origin}/embed/{agentId}</a></p>
      <form className="stack" onSubmit={saveDomains}>
        <h3>Allowed websites</h3>
        <p className="muted">
          Only show the chat on these websites, so nobody else can put your assistant on their site and use up your message
          credits. One per line, e.g. <code>yourbusiness.in</code> (subdomains like www. are included). Leave empty to allow any
          website. The full-page chat link keeps working.
        </p>
        <textarea rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={"yourbusiness.in\nshop.yourbusiness.in"} aria-label="Allowed websites" />
        {error && <p className="error-text">{error}</p>}
        {msg && <p className="ok-text">{msg}</p>}
        <div>
          <button className="btn">Save websites</button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
type WaStatus = {
  connected: boolean;
  source?: "manual" | "embedded";
  embedded?: { available: boolean; appId?: string; configId?: string; graphVersion?: string };
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  webhookUrl?: string;
  verifyToken?: string;
  lastMessageAt?: string | null;
};

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <label>
      {label}
      <div className="row-form">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn ghost" onClick={() => navigator.clipboard?.writeText(value)}>Copy</button>
      </div>
    </label>
  );
}

// ---- Meta (Facebook) JS SDK, used by WhatsApp Embedded Signup -----------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FBSdk = { init: (o: Record<string, unknown>) => void; login: (cb: (r: any) => void, o: Record<string, unknown>) => void };
function loadFacebookSdk(appId: string, version: string): Promise<FBSdk> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.FB) return Promise.resolve(w.FB as FBSdk);
  return new Promise((resolve, reject) => {
    w.fbAsyncInit = () => {
      w.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(w.FB as FBSdk);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.onerror = () => reject(new Error("Couldn't load Facebook's sign-in script. Check your connection or ad-blocker and try again."));
    document.body.appendChild(s);
  });
}
const isFacebookOrigin = (origin: string) => {
  try {
    return /(^|\.)facebook\.com$/.test(new URL(origin).hostname);
  } catch {
    return false;
  }
};

function WhatsAppTab({ agentId }: { agentId: string }) {
  const [st, setSt] = useState<WaStatus | null>(null);
  const [f, setF] = useState({ phoneNumberId: "", accessToken: "", appSecret: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await api<WaStatus>(`/api/agents/${agentId}/whatsapp`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setSt(await api<WaStatus>(`/api/agents/${agentId}/whatsapp`, { method: "PUT", ...json(f) }));
      setF({ phoneNumberId: "", accessToken: "", appSecret: "" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [notice, setNotice] = useState("");

  /** Meta's Embedded Signup popup: the customer logs in, picks/creates their WhatsApp number, and we get a one-time code. */
  async function embeddedSignup() {
    const e = st?.embedded;
    if (!e?.available || !e.appId || !e.configId) return;
    setBusy(true);
    setError("");
    setNotice("");
    let session: { phoneNumberId: string; wabaId: string; businessId?: string } | null = null;
    let cancelledAt: string | null = null;
    const onMessage = (ev: MessageEvent) => {
      if (!isFacebookOrigin(ev.origin)) return;
      try {
        const d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        if (d?.type !== "WA_EMBEDDED_SIGNUP") return;
        if (d.event === "FINISH" && d.data?.phone_number_id && d.data?.waba_id) {
          session = { phoneNumberId: String(d.data.phone_number_id), wabaId: String(d.data.waba_id), businessId: d.data.business_id ? String(d.data.business_id) : undefined };
        } else if (d.event === "CANCEL") cancelledAt = d.data?.current_step ?? "an early step";
      } catch {
        /* not a JSON message from Meta */
      }
    };
    window.addEventListener("message", onMessage);
    try {
      const fb = await loadFacebookSdk(e.appId, e.graphVersion ?? "v25.0");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await new Promise<any>((resolve) =>
        fb.login(resolve, { config_id: e.configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } })
      );
      const code: string | undefined = resp?.authResponse?.code;
      if (!code) throw new Error(cancelledAt ? `Signup was cancelled at ${String(cancelledAt).toLowerCase().replaceAll("_", " ")}.` : "Signup was cancelled.");
      for (let i = 0; i < 50 && !session; i++) await new Promise((r) => setTimeout(r, 100)); // the session message can arrive just after the login callback
      if (!session) throw new Error("Meta did not say which WhatsApp number was connected. Please try again.");
      const s: { phoneNumberId: string; wabaId: string; businessId?: string } = session;
      const r = await api<{ warning?: string }>(`/api/agents/${agentId}/whatsapp/embedded`, { method: "POST", ...json({ code, ...s }) });
      if (r.warning) setNotice(r.warning);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      window.removeEventListener("message", onMessage);
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect WhatsApp? The agent will stop replying on this number.")) return;
    await api(`/api/agents/${agentId}/whatsapp`, { method: "DELETE" }).catch((e) => setError(e.message));
    await load();
  }

  if (!st) return <p className="muted">{error || "Loading…"}</p>;

  return (
    <section className="stack">
      {st.connected ? (
        <div className="card stack">
          <h3>Connected: {st.displayPhoneNumber || st.phoneNumberId} {st.verifiedName && <span className="muted">({st.verifiedName})</span>}</h3>
          <p className="muted small">
            {st.lastMessageAt ? `Last message received ${new Date(st.lastMessageAt).toLocaleString("en-IN")}` : "No messages received yet."}
          </p>
          {st.source === "embedded" ? (
            <p className="muted">Connected through Meta sign-in. Nothing else to set up: message this number from another phone to test it.</p>
          ) : (
            <>
              <p className="muted">Finish setup in Meta: open your app → <strong>WhatsApp → Configuration</strong>, paste these two values, click <strong>Verify and save</strong>, then subscribe to the <strong>messages</strong> webhook field.</p>
              <CopyRow label="Callback URL (must be a public https address)" value={st.webhookUrl ?? ""} />
              <CopyRow label="Verify token" value={st.verifyToken ?? ""} />
            </>
          )}
          {notice && <p className="muted">{notice}</p>}
          <div><button className="btn danger" onClick={disconnect}>Disconnect WhatsApp</button></div>
        </div>
      ) : (
        <>
        {st.embedded?.available && (
          <div className="card stack">
            <h3>Connect your WhatsApp number</h3>
            <p className="muted">Sign in with Facebook, choose or create your WhatsApp Business account and number, and you&apos;re done. No tokens to copy.</p>
            <div>
              <button className="btn" onClick={embeddedSignup} disabled={busy}>{busy ? "Waiting for Meta…" : "Connect with Facebook"}</button>
            </div>
            {error && <p className="error-text">{error}</p>}
          </div>
        )}
        <details open={!st.embedded?.available}>
        {st.embedded?.available && <summary className="muted" style={{ cursor: "pointer", marginBottom: 12 }}>Advanced: connect with your own Meta app and token</summary>}
        <form className="card stack" onSubmit={connect}>
          <h3>Connect a WhatsApp Business number</h3>
          <p className="muted">
            You need a WhatsApp Business Platform (Cloud API) number in a Meta app you control. Copy these from your app in Meta for
            Developers. We check the token works before saving, and store the token and secret encrypted.
          </p>
          <label>Phone number ID<input required value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} placeholder="e.g. 109876543210987" inputMode="numeric" /></label>
          <label>Permanent access token<input required type="password" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} autoComplete="off" /></label>
          <label>App secret<input required type="password" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} autoComplete="off" /></label>
          {error && !st.embedded?.available && <p className="error-text">{error}</p>}
          <button className="btn" disabled={busy}>{busy ? "Checking with WhatsApp…" : "Connect"}</button>
        </form>
        </details>
        </>
      )}
      {st.connected && error && <p className="error-text">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
function ChatsTab({ agentId, convos, refresh, handoffEnabled }: { agentId: string; convos: Convo[] | null; refresh: () => Promise<void>; handoffEnabled: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ conversation: { mode: "bot" | "human"; needs_reply: boolean; contact: string | null; channel: string }; messages: Message[] } | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [onlyWaiting, setOnlyWaiting] = useState(false);

  const loadDetail = useCallback(
    async (cid: string) => {
      try {
        setDetail(await api(`/api/agents/${agentId}/conversations/${cid}`));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [agentId]
  );

  // Open the conversation from the e-mail link, if any.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    if (c && /^[0-9a-f-]{36}$/i.test(c)) setOpen(c);
  }, []);
  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setError("");
    void loadDetail(open);
    const t = setInterval(() => void loadDetail(open), 4000);
    return () => clearInterval(t);
  }, [open, loadDetail]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!open || !reply.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/agents/${agentId}/conversations/${open}/reply`, { method: "POST", ...json({ message: reply }) });
      setReply("");
      await Promise.all([loadDetail(open), refresh()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setMode(mode: "bot" | "human") {
    if (!open) return;
    setError("");
    try {
      await api(`/api/agents/${agentId}/conversations/${open}`, { method: "PATCH", ...json({ mode }) });
      await Promise.all([loadDetail(open), refresh()]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!convos) return <p className="muted">Loading…</p>;
  const shown = onlyWaiting ? convos.filter((c) => c.needs_reply) : convos;
  if (!convos.length) return <p className="muted">No conversations yet. They will appear here once visitors (or you, in the Playground) start chatting.</p>;

  const c = detail?.conversation;
  return (
    <div>
      {handoffEnabled && (
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={onlyWaiting} onChange={(e) => setOnlyWaiting(e.target.checked)} />
          Show only customers waiting for a reply
        </label>
      )}
      <div className="split">
        <ul className="list" style={{ marginTop: 0 }}>
          {shown.length === 0 && <li className="muted">Nobody is waiting for a reply.</li>}
          {shown.map((v) => (
            <li key={v.id}>
              <button className={`card convo${open === v.id ? " active" : ""}`} onClick={() => setOpen(v.id)}>
                <span>
                  {v.needs_reply && <span className="badge alert">Needs reply</span>}
                  {!v.needs_reply && v.mode === "human" && <span className="badge team">With team</span>}
                  {v.contact && <span className="muted small"> {v.contact}</span>}
                </span>
                <strong>{(v.needs_reply ? v.last_visitor_message : v.first_message)?.slice(0, 80) ?? "(empty)"}</strong>
                <span className="muted small">{v.channel} · {v.message_count} messages · {new Date(v.updated_at).toLocaleString("en-IN")}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="card transcript">
          {!open && <p className="muted">Select a conversation</p>}
          {open && !detail && <p className="muted">{error || "Loading…"}</p>}
          {open && detail && c && (
            <>
              <div className="row-form" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <span className="muted small">
                  {c.channel}
                  {c.contact ? ` · ${c.contact}` : ""} · {c.mode === "human" ? "a person is handling this chat" : "the assistant is answering"}
                </span>
                {c.mode === "human" ? (
                  <button className="btn ghost" onClick={() => setMode("bot")}>Hand back to assistant</button>
                ) : (
                  <button className="btn ghost" onClick={() => setMode("human")}>Take over</button>
                )}
              </div>
              <div className="transcript-scroll">
                {detail.messages.map((m) => (
                  <p key={m.id} className={`msg ${m.role}`}>
                    <strong>{m.role === "user" ? "Customer" : m.role === "human" ? "You" : "Assistant"}:</strong> {m.content}
                  </p>
                ))}
              </div>
              <form className="reply-form" onSubmit={send}>
                <textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={4000} placeholder={c.channel === "whatsapp" ? "Reply on WhatsApp…" : "Reply in the website chat…"} />
                {error && <p className="error-text">{error}</p>}
                <div className="row-form">
                  <button className="btn" disabled={busy || !reply.trim()}>{busy ? "Sending…" : "Send reply"}</button>
                  <span className="muted small">Replying pauses the assistant in this chat until you hand it back.</span>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
