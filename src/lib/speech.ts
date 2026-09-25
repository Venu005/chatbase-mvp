import { env, envStr } from "./env";

/**
 * Speech-to-text for WhatsApp voice notes, with Sarvam AI (Hindi, English and 9 other Indian languages, auto-detected).
 * On whenever SARVAM_API_KEY is set (even if another provider writes the answers); VOICE_NOTES=off turns it off.
 * Sarvam's synchronous API takes clips under 30 seconds; longer voice notes get a "please type it" reply.
 */
export const speechToTextConfigured = () => !!env("SARVAM_API_KEY") && env("VOICE_NOTES")?.toLowerCase() !== "off";

export async function transcribe(audio: Uint8Array<ArrayBuffer>, mimeType: string): Promise<{ text: string; language: string | null }> {
  const key = env("SARVAM_API_KEY");
  if (!key) throw new Error("SARVAM_API_KEY is not set");
  const model = envStr("SARVAM_STT_MODEL", "saaras:v3");
  const form = new FormData();
  const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") || mimeType.includes("aac") ? "m4a" : mimeType.includes("amr") ? "amr" : "ogg";
  form.set("file", new Blob([audio], { type: mimeType.split(";")[0] || "audio/ogg" }), `voice.${ext}`);
  form.set("model", model);
  if (model.startsWith("saaras")) form.set("mode", "transcribe"); // keep the speaker's language (not an English translation)
  form.set("language_code", envStr("SARVAM_STT_LANGUAGE", "unknown")); // "unknown" = detect the language
  const res = await fetch(envStr("SARVAM_STT_URL", "https://api.sarvam.ai/speech-to-text"), {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Speech-to-text failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { transcript?: string; language_code?: string | null };
  return { text: (j.transcript ?? "").trim(), language: j.language_code ?? null };
}
