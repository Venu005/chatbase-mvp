import http from "node:http";
import { existsSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";

// Same .env as the other apps (the monorepo root), unless the variables are already set.
const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { env, envNum } = await import("@chatbase/core/env");
const { loadVoiceAgent, VoiceSession } = await import("@chatbase/core/voice/session");
const { checkVoiceTicket } = await import("@chatbase/core/voice/ticket");
const { pcmFromBytes, pcmToBytes, ulawDecode, ulawEncode } = await import("@chatbase/core/voice/audio");
type Session = InstanceType<typeof VoiceSession>;

/**
 * The voice gateway: WebSocket audio for the agents' voice conversations, next to the customer app.
 *
 *   /web?ticket=…                          website voice mode (the chat widget's microphone button)
 *   /plivo/:agentId/answer?token=…         Plivo "Answer URL" (returns XML that streams the call here)
 *   /plivo/:agentId/stream?token=…         Plivo audio stream (WebSocket)
 *   /plivo/:agentId/transfer?token=…       Plivo transfer target (returns XML that dials the agent's transfer number)
 *   /exotel/:agentId?token=…               Exotel Voicebot applet stream (WebSocket)
 *
 * All of them feed the same engine (@chatbase/core/voice/session). The token is the agent's voice_token (shown in
 * the dashboard's Voice settings), so only the owner's phone provider can start calls on that agent.
 */

const PORT = envNum("VOICE_PORT", 3002);
const PUBLIC = (env("VOICE_PUBLIC_URL") ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const WS_PUBLIC = PUBLIC.replace(/^http/, "ws");
const MAX_MS = envNum("VOICE_MAX_MINUTES", 15) * 60_000;
const WEB_OUT_RATE = envNum("VOICE_WEB_OUTPUT_RATE", 22050);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-15);
const safeId = (s: string | null | undefined) => (s ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || Math.random().toString(36).slice(2, 10);

async function agentFor(agentId: string, token: string | null) {
  const agent = await loadVoiceAgent(agentId);
  return agent && token && token === agent.voice_token ? agent : null;
}

/** Ends the session after VOICE_MAX_MINUTES, and when the socket closes. */
function lifetime(ws: WebSocket, session: () => Session | null) {
  const t = setTimeout(() => ws.close(1000, "Maximum call length reached"), MAX_MS);
  ws.on("close", () => (clearTimeout(t), session()?.close()));
}

// ---- HTTP: Plivo XML answers, health ------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", PUBLIC);
    if (url.pathname === "/health") return void res.end("ok");
    const m = /^\/plivo\/([0-9a-f-]{36})\/(answer|transfer)$/i.exec(url.pathname);
    if (m) {
      const agent = await agentFor(m[1], url.searchParams.get("token"));
      if (!agent) return void ((res.statusCode = 403), res.end("Forbidden"));
      const body = await new Promise<string>((r) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => r(b));
      });
      const p = new URLSearchParams(body);
      const get = (k: string) => p.get(k) ?? url.searchParams.get(k);
      res.setHeader("content-type", "application/xml");
      if (m[2] === "answer") {
        const stream = `${WS_PUBLIC}/plivo/${agent.id}/stream?token=${agent.voice_token}&from=${digits(get("From"))}&call=${safeId(get("CallUUID"))}`;
        return void res.end(
          `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${xml(stream)}</Stream></Response>`
        );
      }
      const to = agent.voice_transfer_number;
      return void res.end(
        to
          ? `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Dial><Number>${xml(to)}</Number></Dial></Response>`
          : `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>`
      );
    }
    res.statusCode = 404;
    res.end("Not found");
  } catch (e) {
    console.error("Voice HTTP error:", e);
    res.statusCode = 500;
    res.end("Error");
  }
});

// ---- WebSockets ----------------------------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const perIp = new Map<string, number>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", PUBLIC);
  const reject = (code: number) => (socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n\r\n`), socket.destroy());
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() || req.socket.remoteAddress || "";

  if (url.pathname === "/web") {
    // Only pages of the customer app (the widget's iframe, the dashboard) may open website voice sessions.
    const app = env("APP_URL");
    if (app && req.headers.origin && new URL(app).origin !== req.headers.origin) return reject(403);
    const ticket = checkVoiceTicket(url.searchParams.get("ticket") ?? "");
    if (!ticket) return reject(401);
    if ((perIp.get(ip) ?? 0) >= envNum("VOICE_MAX_PER_IP", 3)) return reject(429);
    return wss.handleUpgrade(req, socket, head, (ws) => void webSession(ws, ticket, ip));
  }
  const plivo = /^\/plivo\/([0-9a-f-]{36})\/stream$/i.exec(url.pathname);
  const exotel = /^\/exotel\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (!plivo && !exotel) return reject(404);
  void agentFor((plivo ?? exotel)![1], url.searchParams.get("token")).then((agent) => {
    if (!agent) return reject(403);
    wss.handleUpgrade(req, socket, head, (ws) => (plivo ? plivoSession(ws, agent, url) : exotelSession(ws, agent)));
  }, () => reject(500));
});

type Agent = NonNullable<Awaited<ReturnType<typeof loadVoiceAgent>>>;

// ---- website voice mode ----------------------------------------------------------------------------------------
// Browser → gateway: binary 16 kHz 16-bit PCM. Gateway → browser: {"type":"ready",…}, binary PCM at outputRate,
// {"type":"clear"} (stop playback: the visitor interrupted), and the engine's events as JSON.
async function webSession(ws: WebSocket, t: { agentId: string; sessionId: string }, ip: string) {
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  ws.on("close", () => perIp.set(ip, Math.max(0, (perIp.get(ip) ?? 1) - 1)));
  const agent = await loadVoiceAgent(t.agentId);
  if (!agent?.voice_enabled) return ws.close(4403, "Voice is not enabled for this assistant");
  const json = (o: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
  const session = new VoiceSession(agent, {
    sessionId: t.sessionId,
    channel: "voice",
    inputRate: 16000,
    outputRate: WEB_OUT_RATE,
    io: {
      audio: (pcm) => ws.readyState === ws.OPEN && ws.send(pcmToBytes(pcm)),
      clear: () => json({ type: "clear" }),
      event: (e) => json(e),
    },
  });
  lifetime(ws, () => session);
  ws.on("message", (data, binary) => {
    if (binary) session.push(pcmFromBytes(new Uint8Array(data as Buffer)));
  });
  json({ type: "ready", inputRate: 16000, outputRate: WEB_OUT_RATE });
  session.start();
}

// ---- Plivo audio streams (bidirectional, μ-law 8 kHz) -------------------------------------------------------
function plivoSession(ws: WebSocket, agent: Agent, url: URL) {
  let session: Session | null = null;
  let streamId = "";
  const callId = url.searchParams.get("call") ?? "";
  const send = (o: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
  lifetime(ws, () => session);
  ws.on("message", (raw) => {
    let m: { event?: string; start?: { streamId?: string; callId?: string }; media?: { payload?: string } };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.event === "start" && !session) {
      streamId = m.start?.streamId ?? "";
      const call = safeId(m.start?.callId ?? callId);
      const from = digits(url.searchParams.get("from")) || "0";
      session = new VoiceSession(agent, {
        sessionId: `ph_${from.length >= 6 ? from : "000000"}_${call}`,
        channel: "phone",
        inputRate: 8000,
        outputRate: 8000,
        io: {
          audio: (pcm) => {
            const bytes = ulawEncode(pcm);
            for (let i = 0; i < bytes.length; i += 1600) // 200 ms chunks
              send({ event: "playAudio", media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: Buffer.from(bytes.subarray(i, i + 1600)).toString("base64") } });
          },
          clear: () => send({ event: "clearAudio", streamId }),
          event: (e) => e.type === "error" && console.error(`Plivo call ${call}:`, e.message),
          transfer: (to) => plivoTransfer(agent, m.start?.callId ?? callId, to),
          hangup: () => ws.close(1000, "Call ended by the assistant"),
        },
      });
      session.start();
    } else if (m.event === "media" && m.media?.payload) {
      session?.push(ulawDecode(new Uint8Array(Buffer.from(m.media.payload, "base64"))));
    } else if (m.event === "stop") {
      ws.close();
    }
  });
}

/** Moves the caller's leg to the transfer URL, which dials the agent's transfer number. */
async function plivoTransfer(agent: Agent, callUuid: string, _to: string) {
  const id = env("PLIVO_AUTH_ID");
  const token = env("PLIVO_AUTH_TOKEN");
  if (!id || !token) throw new Error("Set PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN to transfer calls");
  const res = await fetch(`${env("PLIVO_API_BASE") ?? "https://api.plivo.com"}/v1/Account/${id}/Call/${encodeURIComponent(callUuid)}/`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${id}:${token}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ legs: "aleg", aleg_url: `${PUBLIC}/plivo/${agent.id}/transfer?token=${agent.voice_token}`, aleg_method: "POST" }),
  });
  if (!res.ok) throw new Error(`Plivo transfer failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// ---- Exotel Voicebot streams (16-bit PCM, 8 kHz by default) ------------------------------------------------
// Handing off = ending the stream: the Exotel call flow then continues with its next applet (put a "Connect"
// applet to the owner's number after the Voicebot applet).
function exotelSession(ws: WebSocket, agent: Agent) {
  let session: Session | null = null;
  let sid = "";
  const send = (o: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
  lifetime(ws, () => session);
  ws.on("message", (raw) => {
    let m: {
      event?: string;
      stream_sid?: string;
      start?: { stream_sid?: string; call_sid?: string; from?: string; media_format?: { sample_rate?: string | number } };
      media?: { payload?: string };
    };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.event === "start" && !session) {
      sid = m.start?.stream_sid ?? m.stream_sid ?? "";
      const rate = Number(m.start?.media_format?.sample_rate) || 8000;
      const from = digits(m.start?.from);
      const call = safeId(m.start?.call_sid);
      const end = () => setTimeout(() => ws.close(1000, "Handing over"), 100);
      session = new VoiceSession(agent, {
        sessionId: `ph_${from.length >= 6 ? from : "000000"}_${call}`,
        channel: "phone",
        inputRate: rate,
        outputRate: rate,
        io: {
          audio: (pcm) => {
            // Exotel wants chunks in multiples of 320 bytes: pad the last one with silence.
            const step = (rate / 1000) * 200 * 2; // 200 ms
            const bytes = pcmToBytes(pcm);
            for (let i = 0; i < bytes.length; i += step) {
              let chunk = bytes.subarray(i, i + step);
              if (chunk.length % 320) chunk = Buffer.concat([chunk, Buffer.alloc(320 - (chunk.length % 320))]);
              send({ event: "media", stream_sid: sid, media: { payload: Buffer.from(chunk).toString("base64") } });
            }
          },
          clear: () => send({ event: "clear", stream_sid: sid }),
          event: (e) => e.type === "error" && console.error(`Exotel call ${call}:`, e.message),
          transfer: async () => void end(),
          hangup: end,
        },
      });
      session.start();
    } else if (m.event === "media" && m.media?.payload) {
      session?.push(pcmFromBytes(new Uint8Array(Buffer.from(m.media.payload, "base64"))));
    } else if (m.event === "stop") {
      ws.close();
    }
  });
}

server.listen(PORT, () => console.log(`Voice gateway on :${PORT} (public ${PUBLIC})`));
