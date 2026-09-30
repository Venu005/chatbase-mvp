// End-to-end test of voice agents against the RUNNING customer app (:3000) and voice gateway (:3002): website voice
// mode, Plivo and Exotel phone calls, barge-in, handoff and call transfer, latency. This script runs a fake Sarvam
// (speech-to-text and text-to-speech) on :4020 and a fake Plivo API on :4031. Start both apps with
//   SARVAM_API_KEY=sarvam-test-key SARVAM_STT_URL=http://127.0.0.1:4020/speech-to-text
//   SARVAM_TTS_URL=http://127.0.0.1:4020/text-to-speech VOICE_PUBLIC_URL=http://127.0.0.1:3002
//   PLIVO_AUTH_ID=MA_TEST PLIVO_AUTH_TOKEN=plivo-test-token PLIVO_API_BASE=http://127.0.0.1:4031
// then  pnpm smoke:voice
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
import WebSocket from "ws";

const pg = createRequire(new URL("../../../packages/core/package.json", import.meta.url))("pg");
const WEB = process.env.BASE_URL ?? "http://localhost:3000";
const VOICE = process.env.VOICE_BASE_URL ?? "http://127.0.0.1:3002";
const ORIGIN = new URL(process.env.APP_URL ?? WEB).origin;
const IP = `10.96.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- audio helpers (same formats as the gateway) -----------------------------------------------------------
const tone = (ms, rate, amp = 7000) => Int16Array.from({ length: Math.round((ms / 1000) * rate) }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * 300 * i) / rate)));
const silence = (ms, rate) => new Int16Array(Math.round((ms / 1000) * rate));
const bytes = (pcm) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.byteLength, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([h, bytes(pcm)]);
}
function ulaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i];
    const sign = s < 0 ? 0x80 : 0;
    s = Math.min(Math.abs(s), 32635) + 0x84;
    let e = 7;
    for (let m = 0x4000; (s & m) === 0 && e > 0; m >>= 1) e--;
    out[i] = ~(sign | (e << 4) | ((s >> (e + 3)) & 0x0f)) & 0xff;
  }
  return out;
}
/** Caller says something: speech, then enough silence for the end of the sentence to be detected. */
const utterance = (rate, speechMs = 600) => [tone(speechMs, rate), silence(900, rate)];
const frames = (pcm, rate, ms = 20) => Array.from({ length: Math.ceil(pcm.length / ((rate * ms) / 1000)) }, (_, i) => pcm.subarray((i * rate * ms) / 1000, ((i + 1) * rate * ms) / 1000));

// ---- fake Sarvam and Plivo ---------------------------------------------------------------------------------
const heard = []; // transcripts the fake speech-to-text returns, in order
const stt = [];
const tts = [];
const plivoCalls = [];
const fakes = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.url === "/speech-to-text") {
      stt.push({ key: req.headers["api-subscription-key"], wav: body.includes(Buffer.from("WAVEfmt")) });
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ transcript: heard.shift() ?? "", language_code: "en-IN" }));
    }
    if (req.url === "/text-to-speech") {
      const j = JSON.parse(body.toString());
      tts.push(j);
      // 30 ms of audio per character, so long answers take a while to play (room to interrupt).
      const rate = j.speech_sample_rate;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ audios: [wav(tone(j.text.length * 30, rate, 3000), rate).toString("base64")] }));
    }
    if (req.url.startsWith("/v1/Account/")) {
      plivoCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body.toString() || "{}") });
      res.statusCode = 202;
      return res.end("{}");
    }
    res.statusCode = 404;
    res.end();
  });
});
await new Promise((r) => fakes.listen(4020, "127.0.0.1", r));
await new Promise((r) => {
  const p = http.createServer((q, s) => fakes.emit("request", q, s));
  p.listen(4031, "127.0.0.1", r);
  fakes.on("close", () => p.close());
});

function client(base) {
  let cookie = "";
  return {
    async json(path, { method = "GET", body } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { "x-forwarded-for": IP, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return { status: res.status, data: await res.json().catch(() => ({})) };
    },
  };
}

/** Opens a WebSocket and records everything that comes back. */
function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const log = { json: [], audio: [], closed: null };
    ws.on("message", (d, binary) => (binary ? log.audio.push({ at: Date.now(), n: d.length }) : log.json.push({ at: Date.now(), ...JSON.parse(String(d)) })));
    ws.on("close", (code, reason) => (log.closed = { code, reason: String(reason) }));
    ws.on("open", () => resolve({ ws, log }));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}
async function until(fn, ms = 8000, what = "condition") {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(25)) {
    const v = fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
console.log(`Voice smoke test against ${WEB} and ${VOICE}\n`);

try {
  const a = client(WEB);
  assert.equal((await a.json("/api/auth/signup", { method: "POST", body: { email: `voice${Date.now()}@example.com`, password: "password-123" } })).status, 200);
  const agentId = (await a.json("/api/agents", { method: "POST", body: { name: "Voice Bot" } })).data.agent.id;
  await a.json(`/api/agents/${agentId}/sources`, { method: "POST", body: { type: "text", title: "Prices", text: "Basmati rice costs Rs 610 for a 5 kg bag. We deliver across Pune within 2 days." } });
  for (let i = 0; i < 60 && (await a.json(`/api/agents/${agentId}/sources`)).data.sources.some((s) => s.status === "processing"); i++) await sleep(250);
  const sessionId = crypto.randomBytes(12).toString("hex");

  // ---- settings and tickets
  assert.equal((await a.json(`/api/voice/${agentId}/ticket`, { method: "POST", body: { sessionId } })).status, 403, "voice is off by default");
  assert.equal((await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { voiceTransferNumber: "98765" } })).status, 400);
  assert.equal((await a.json(`/api/agents/${agentId}`, { method: "PATCH", body: { voiceEnabled: true, voiceSpeaker: "karun", voiceGreeting: "Namaste! Ask me anything.", voiceTransferNumber: "+91 99999 00000" } })).status, 200);
  const got = (await a.json(`/api/agents/${agentId}`)).data;
  assert.equal(got.agent.voice_transfer_number, "+919999900000");
  assert.ok(got.voice.plivoAnswerUrl.startsWith(`${VOICE}/plivo/${agentId}/answer?token=`) && got.voice.exotelStreamUrl.startsWith("ws://"), JSON.stringify(got.voice));
  const ticket = await a.json(`/api/voice/${agentId}/ticket`, { method: "POST", body: { sessionId } });
  assert.equal(ticket.status, 200);
  await assert.rejects(connect(ticket.data.url.replace(/ticket=[^&]+/, "ticket=forged.sig"), { origin: ORIGIN }), /HTTP 401/);
  await assert.rejects(connect(ticket.data.url, { origin: "https://evil.example" }), /HTTP 403/);
  ok("voice settings (voice, greeting, transfer number) and signed tickets; forged tickets and other websites are refused");

  // ---- website voice mode: a question, answered out loud
  const { ws, log } = await connect(ticket.data.url, { origin: ORIGIN });
  const ready = await until(() => log.json.find((e) => e.type === "ready"), 5000, "ready");
  assert.equal(ready.inputRate, 16000);
  await until(() => log.audio.length > 0, 5000, "greeting audio");
  assert.equal(tts.at(-1).text, "Namaste! Ask me anything.");
  assert.equal(tts.at(-1).speaker, "karun");
  const greetMs = (log.audio.reduce((t, x) => t + x.n, 0) / 2 / ready.outputRate) * 1000;
  await sleep(greetMs + 150); // let the greeting finish (talking over it would interrupt it)

  heard.push("What is the price of basmati rice?");
  const sentAt = Date.now();
  for (const part of utterance(16000)) for (const f of frames(part, 16000)) ws.send(bytes(f));
  const reply = await until(() => log.json.find((e) => e.type === "reply"), 10000, "reply");
  assert.ok(log.json.find((e) => e.type === "transcript")?.text === "What is the price of basmati rice?");
  assert.match(reply.text, /610/);
  const metrics = await until(() => log.json.find((e) => e.type === "metrics"));
  assert.ok(metrics.firstAudioMs !== null && metrics.firstAudioMs < 1500, `first audio after ${metrics.firstAudioMs} ms`);
  assert.ok(log.audio.some((x) => x.at > sentAt), "the answer is spoken");
  assert.ok(stt.at(-1).wav && stt.at(-1).key === "sarvam-test-key");
  const call = (await db.query("SELECT channel, status, first_audio_ms, question FROM ai_calls WHERE agent_id = $1 AND kind = 'answer' ORDER BY id DESC LIMIT 1", [agentId])).rows[0];
  assert.equal(call.channel, "voice");
  assert.ok(call.status === "ok" && call.first_audio_ms > 0 && call.question.includes("basmati"), JSON.stringify(call));
  ok(`website voice: speech → transcript → answer from the sources, spoken (first audio after ${metrics.firstAudioMs} ms)`);

  // ---- barge-in: talking while the assistant speaks stops it at once
  await until(() => log.json.some((e) => e.type === "state" && e.state === "listening" && e.at > reply.at), 15000, "listening again");
  heard.push("Tell me everything about delivery and prices please");
  const before = log.json.length;
  for (const part of utterance(16000)) for (const f of frames(part, 16000)) ws.send(bytes(f));
  await until(() => log.json.slice(before).some((e) => e.type === "reply"), 10000, "second reply");
  heard.push("Thanks");
  const cut = log.json.length;
  for (const f of frames(tone(400, 16000), 16000)) ws.send(bytes(f)); // starts talking over the answer
  await until(() => log.json.slice(cut).some((e) => e.type === "clear"), 3000, "clear (barge-in)");
  assert.ok(log.json.slice(cut).some((e) => e.type === "interrupted"));
  for (const f of frames(silence(900, 16000), 16000)) ws.send(bytes(f));
  await until(() => log.json.slice(cut).some((e) => e.type === "transcript" && e.text === "Thanks"), 8000, "the interrupting sentence");
  ok("barge-in: when the visitor talks over the answer, playback is cleared and the new sentence is answered");

  // ---- website handoff
  await until(() => log.json.slice(cut).some((e) => e.type === "reply"), 10000, "reply to thanks");
  await sleep(1500);
  heard.push("I want to talk to a human");
  const h0 = log.json.length;
  for (const part of utterance(16000)) for (const f of frames(part, 16000)) ws.send(bytes(f));
  const handoff = await until(() => log.json.slice(h0).find((e) => e.type === "handoff"), 8000, "handoff");
  assert.equal(handoff.transfer, false);
  const convo = (await db.query("SELECT mode FROM conversations WHERE agent_id = $1 AND session_id = $2", [agentId, sessionId])).rows[0];
  assert.equal(convo.mode, "human");
  ws.close();
  ok("asking for a person in voice mode hands the chat to the owner (the widget switches to the team's replies)");

  // ---- Plivo phone call
  const answerUrl = got.voice.plivoAnswerUrl;
  const bad = await fetch(answerUrl.replace(/token=\w+/, "token=wrong"), { method: "POST" });
  assert.equal(bad.status, 403);
  const xmlRes = await fetch(answerUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "From=%2B919812345678&CallUUID=abc-123&To=%2B918000000000" });
  const xml = await xmlRes.text();
  const streamUrl = /<Stream[^>]*bidirectional="true"[^>]*>([^<]+)<\/Stream>/.exec(xml)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(streamUrl?.startsWith(`ws://127.0.0.1:3002/plivo/${agentId}/stream?token=`), xml);
  const pl = await connect(streamUrl);
  pl.ws.send(JSON.stringify({ event: "start", start: { callId: "abc-123", streamId: "st-1" } }));
  const plays = () => pl.log.json.filter((e) => e.event === "playAudio");
  await until(() => plays().length > 0, 5000, "greeting on the call");
  assert.equal(plays()[0].media.contentType, "audio/x-mulaw");
  const greet8k = plays().reduce((t, e) => t + Buffer.from(e.media.payload, "base64").length, 0) / 8;
  await sleep(greet8k + 150);
  heard.push("price of basmati rice");
  const p0 = plays().length;
  const sendUlaw = (pcm) => { for (const f of frames(pcm, 8000)) pl.ws.send(JSON.stringify({ event: "media", media: { payload: ulaw(f).toString("base64") } })); };
  utterance(8000).forEach(sendUlaw);
  await until(() => plays().length > p0, 8000, "spoken answer on the call");
  let phoneRow;
  for (let i = 0; i < 100 && !phoneRow; i++, await sleep(50))
    phoneRow = (await db.query("SELECT c.session_id FROM ai_calls k JOIN conversations c ON c.id = k.conversation_id WHERE k.agent_id = $1 AND k.channel = 'phone' ORDER BY k.id DESC LIMIT 1", [agentId])).rows[0];
  assert.equal(phoneRow.session_id, "ph_919812345678_abc-123");
  // barge-in on the phone
  heard.push("hello");
  sendUlaw(tone(400, 8000));
  await until(() => pl.log.json.some((e) => e.event === "clearAudio" && e.streamId === "st-1"), 3000, "clearAudio");
  sendUlaw(silence(900, 8000));
  await sleep(1500);
  ok("Plivo: the Answer URL streams the call to the gateway (μ-law 8 kHz); answers are spoken, and barge-in clears the caller's audio");

  // transfer to a person
  heard.push("please connect me to a person");
  utterance(8000).forEach(sendUlaw);
  await until(() => plivoCalls.length > 0, 10000, "Plivo transfer API call");
  const tr = plivoCalls[0];
  assert.equal(tr.url, "/v1/Account/MA_TEST/Call/abc-123/");
  assert.equal(tr.auth, `Basic ${Buffer.from("MA_TEST:plivo-test-token").toString("base64")}`);
  assert.equal(tr.body.legs, "aleg");
  const dial = await (await fetch(tr.body.aleg_url, { method: "POST" })).text();
  assert.match(dial, /<Dial><Number>\+919999900000<\/Number><\/Dial>/);
  pl.ws.close();
  const list = (await a.json(`/api/agents/${agentId}/conversations`)).data;
  const phoneConvo = (list.conversations ?? list).find?.((c) => c.channel === "phone");
  assert.ok(phoneConvo && phoneConvo.contact === "+919812345678", JSON.stringify(phoneConvo));
  assert.equal((await a.json(`/api/agents/${agentId}/conversations/${phoneConvo.id}/reply`, { method: "POST", body: { message: "hi" } })).status, 409);
  ok("Plivo: asking for a person transfers the call to the owner's number; the dashboard shows the caller's number to call back");

  // ---- Exotel phone call
  await assert.rejects(connect(got.voice.exotelStreamUrl.replace(/token=\w+/, "token=wrong")), /HTTP 403/);
  const ex = await connect(got.voice.exotelStreamUrl);
  ex.ws.send(JSON.stringify({ event: "connected" }));
  ex.ws.send(JSON.stringify({ event: "start", stream_sid: "ex-1", start: { stream_sid: "ex-1", call_sid: "ex-call-9", from: "09876543210", media_format: { encoding: "raw/slin", sample_rate: "8000" } } }));
  const media = () => ex.log.json.filter((e) => e.event === "media");
  await until(() => media().length > 0, 5000, "Exotel greeting");
  assert.ok(media().every((e) => e.stream_sid === "ex-1" && Buffer.from(e.media.payload, "base64").length % 320 === 0), "chunks are multiples of 320 bytes");
  await sleep(media().reduce((t, e) => t + Buffer.from(e.media.payload, "base64").length, 0) / 16 + 150);
  heard.push("do you deliver to Pune");
  const e0 = media().length;
  const sendSlin = (pcm) => { for (const f of frames(pcm, 8000)) ex.ws.send(JSON.stringify({ event: "media", stream_sid: "ex-1", media: { payload: bytes(f).toString("base64") } })); };
  utterance(8000).forEach(sendSlin);
  await until(() => media().length > e0, 8000, "Exotel spoken answer");
  await sleep(media().slice(e0).reduce((t, e) => t + Buffer.from(e.media.payload, "base64").length, 0) / 16 + 300);
  heard.push("mujhe insaan se baat karni hai");
  utterance(8000).forEach(sendSlin);
  await until(() => ex.log.closed, 15000, "Exotel stream closed for the transfer");
  assert.equal(ex.log.closed.code, 1000);
  ok("Exotel: 16-bit 8 kHz streams in 320-byte chunks; asking for a person (in Hinglish) ends the bot leg so the call flow connects the owner");
} catch (e) {
  console.error("\n✗ FAILED:", e.stack ?? e.message);
  process.exitCode = 1;
} finally {
  await db.end();
  fakes.close();
}
if (!process.exitCode) console.log(`\nAll ${passed} voice checks passed.`);
setTimeout(() => process.exit(), 200).unref();
