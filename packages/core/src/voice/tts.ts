import { env, envNum, envStr } from "../env";
import { fromWav, resample, tone } from "./audio";

/**
 * Text-to-speech for voice agents. TTS_PROVIDER=sarvam (Bulbul: Hindi, English and 9 other Indian languages; needs
 * SARVAM_API_KEY) or mock (an offline beep per word, for development and tests). Defaults to sarvam when
 * SARVAM_API_KEY is set, else mock. Returns 16-bit mono PCM at the requested rate.
 */
export type Speech = { pcm: Int16Array; rate: number };

export const ttsProvider = () => (env("TTS_PROVIDER") ?? (env("SARVAM_API_KEY") ? "sarvam" : "mock")).toLowerCase();

/** Sarvam's language codes; "unknown" / null (not detected) falls back to the agent's voice language. */
const SARVAM_LANGS = new Set(["hi-IN", "en-IN", "bn-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "gu-IN", "pa-IN", "od-IN"]);
export const ttsLanguage = (detected: string | null, fallback: string) => (detected && SARVAM_LANGS.has(detected) ? detected : SARVAM_LANGS.has(fallback) ? fallback : "en-IN");

export async function synthesize(text: string, o: { language: string; speaker: string; rate: number; signal?: AbortSignal }): Promise<Speech> {
  if (ttsProvider() === "mock") {
    // About 60 ms of tone per word with a short gap, so tests can "hear" how long an answer is.
    const words = Math.max(1, text.split(/\s+/).filter(Boolean).length);
    return { pcm: tone(words * envNum("MOCK_TTS_MS_PER_WORD", 60), o.rate, 330, 5000), rate: o.rate };
  }
  const key = env("SARVAM_API_KEY");
  if (!key) throw new Error("SARVAM_API_KEY is not set");
  const res = await fetch(envStr("SARVAM_TTS_URL", "https://api.sarvam.ai/text-to-speech"), {
    method: "POST",
    headers: { "api-subscription-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      text: text.slice(0, 1500),
      target_language_code: o.language,
      speaker: o.speaker,
      model: envStr("SARVAM_TTS_MODEL", "bulbul:v2"),
      speech_sample_rate: o.rate >= 22050 ? 22050 : o.rate >= 16000 ? 16000 : 8000,
      enable_preprocessing: true,
    }),
    signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(envNum("TTS_TIMEOUT_MS", 10_000))]) : AbortSignal.timeout(envNum("TTS_TIMEOUT_MS", 10_000)),
  });
  if (!res.ok) throw new Error(`Text-to-speech failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { audios?: string[] };
  if (!j.audios?.length) throw new Error("Text-to-speech returned no audio");
  const wav = fromWav(new Uint8Array(Buffer.from(j.audios[0], "base64")));
  return { pcm: resample(wav.pcm, wav.rate, o.rate), rate: o.rate };
}
