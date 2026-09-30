"use client";

/**
 * Browser side of website voice mode: microphone → 16 kHz 16-bit PCM → the voice gateway (WebSocket), and the
 * assistant's audio back → speakers. The gateway does the listening, thinking and barge-in; this only moves audio.
 * The browser's echo cancellation keeps the assistant's own voice out of the microphone.
 */

export type VoiceServerEvent =
  | { type: "ready"; inputRate: number; outputRate: number }
  | { type: "clear" }
  | { type: "state"; state: "listening" | "thinking" | "speaking" }
  | { type: "transcript"; text: string }
  | { type: "reply"; text: string; partial: boolean }
  | { type: "interrupted" }
  | { type: "handoff"; notice: string | null }
  | { type: "error"; message: string }
  | { type: "metrics"; firstAudioMs: number | null };

// Collects microphone samples and posts them to the main thread in ~20 ms blocks.
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) { this.buf.push(new Float32Array(ch)); this.n += ch.length; }
    if (this.n >= sampleRate / 50) {
      const out = new Float32Array(this.n); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0;
    }
    return true;
  }
}
registerProcessor("cb-capture", Capture);`;

/** Averages blocks of samples down to 16 kHz and converts to 16-bit PCM. */
function to16k(input: Float32Array, rate: number): Int16Array {
  const ratio = rate / 16000;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += input[j];
    const v = s / Math.max(1, b - a);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

export class VoiceClient {
  private ws: WebSocket | null = null;
  private mic: MediaStream | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private outRate = 22050;
  private playAt = 0;
  private playing: AudioBufferSourceNode[] = [];
  private onEvent: (e: VoiceServerEvent) => void;
  private onClose: (reason: string) => void;

  constructor(onEvent: (e: VoiceServerEvent) => void, onClose: (reason: string) => void) {
    this.onEvent = onEvent;
    this.onClose = onClose;
  }

  /** Asks for the microphone, gets a ticket from the customer app and connects to the gateway. */
  async start(agentId: string, sessionId: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the microphone.");
    const r = await fetch(`/api/voice/${agentId}/ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? "Voice isn't available right now.");
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.outCtx = new AudioContext();
    this.inCtx = new AudioContext();
    await this.inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    const source = this.inCtx.createMediaStreamSource(this.mic);
    const node = new AudioWorkletNode(this.inCtx, "cb-capture");
    const rate = this.inCtx.sampleRate;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(to16k(e.data, rate).buffer);
    };
    source.connect(node);

    const ws = new WebSocket(j.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return this.play(new Int16Array(m.data as ArrayBuffer));
      const ev = JSON.parse(m.data) as VoiceServerEvent;
      if (ev.type === "ready") this.outRate = ev.outputRate;
      if (ev.type === "clear") this.flush();
      this.onEvent(ev);
    };
    ws.onclose = (e) => {
      this.stop();
      this.onClose(e.reason || (e.code === 1000 ? "" : "The voice connection closed."));
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Couldn't connect to the voice service."));
    });
  }

  /** Queues the assistant's audio right after what is already playing. */
  private play(pcm: Int16Array) {
    const ctx = this.outCtx;
    if (!ctx || !pcm.length) return;
    const buf = ctx.createBuffer(1, pcm.length, this.outRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.playAt = Math.max(this.playAt, ctx.currentTime + 0.02);
    src.start(this.playAt);
    this.playAt += buf.duration;
    this.playing.push(src);
    src.onended = () => (this.playing = this.playing.filter((s) => s !== src));
  }

  /** The visitor interrupted: stop talking at once. */
  private flush() {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.playing = [];
    this.playAt = 0;
  }

  stop() {
    this.flush();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    void this.inCtx?.close().catch(() => {});
    void this.outCtx?.close().catch(() => {});
    this.inCtx = this.outCtx = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000);
    this.ws = null;
  }
}
