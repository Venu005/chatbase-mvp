/**
 * Audio helpers for the voice engine (pure, no imports, unit-tested): G.711 μ-law (Plivo phone calls), 16-bit PCM,
 * resampling between 8 kHz (phone), 16 kHz (the engine) and the text-to-speech rate, WAV files, and loudness.
 * PCM is mono little-endian 16-bit, as Int16Array.
 */

// ---- μ-law ---------------------------------------------------------------------------------------------------
const BIAS = 0x84;
const CLIP = 32635;

function linearToUlaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const ULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    t[i] = sign ? -magnitude : magnitude;
  }
  return t;
})();

export function ulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ULAW_TABLE[bytes[i]];
  return out;
}

export function ulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToUlaw(pcm[i]);
  return out;
}

// ---- PCM bytes ---------------------------------------------------------------------------------------------------
export function pcmFromBytes(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.length / 2);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function pcmToBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
  return out;
}

/** Linear-interpolation resampling (plenty for speech between 8, 16, 22.05 and 24 kHz). */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || pcm.length === 0) return pcm;
  const n = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = pcm[Math.min(j, pcm.length - 1)];
    const b = pcm[Math.min(j + 1, pcm.length - 1)];
    out[i] = Math.round(a + (b - a) * (x - j));
  }
  return out;
}

export function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

// ---- WAV -----------------------------------------------------------------------------------------------------
export function toWav(pcm: Int16Array, rate: number): Uint8Array {
  const data = pcmToBytes(pcm);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data.length, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/** Reads a 16-bit PCM WAV (mono, or the first channel of stereo). */
export function fromWav(bytes: Uint8Array): { rate: number; pcm: Int16Array } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let o = 12;
  let rate = 16000;
  let channels = 1;
  let bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`Unsupported WAV: ${bits}-bit`);
      const end = Math.min(bytes.length, o + 8 + (size || bytes.length));
      const all = pcmFromBytes(bytes.subarray(o + 8, end));
      if (channels === 1) return { rate, pcm: all };
      const mono = new Int16Array(Math.floor(all.length / channels));
      for (let i = 0; i < mono.length; i++) mono[i] = all[i * channels];
      return { rate, pcm: mono };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data");
}

/** Root-mean-square loudness of a frame (0 … 32768). */
export function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length);
}

/** A sine tone (tests and the offline mock voice). */
export function tone(ms: number, rate: number, hz = 440, amplitude = 6000): Int16Array {
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
  return out;
}
