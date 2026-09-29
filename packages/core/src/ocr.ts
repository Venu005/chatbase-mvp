import { env, envNum, envStr } from "./env";
import { ProviderError, assertOk, type Usage } from "./providers/types";
import { withRetries } from "./providers/resilient";

/**
 * Reads text from scanned PDFs and images (price-list photos, menus) with a vision model. Off unless OCR_PROVIDER is set:
 *   OCR_PROVIDER=openai     any OpenAI-compatible chat API that accepts images and PDF files (OCR_BASE_URL, OCR_API_KEY
 *                           default to OPENAI_BASE_URL / OPENAI_API_KEY)
 *   OCR_PROVIDER=anthropic  Anthropic Messages API (image and PDF document blocks; defaults to ANTHROPIC_* settings)
 *   OCR_MODEL               a vision-capable model id (required)
 */
export const ocrConfigured = () => !!(env("OCR_PROVIDER") && env("OCR_MODEL"));
export const OCR_IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

const PROMPT =
  "Transcribe all the text in this document exactly as written, in its original language and script. Keep prices, " +
  "product names, codes, phone numbers and times exactly. Write tables and price lists one row per line, like " +
  '"Masala dosa - ₹80". Do not summarise, translate or add anything. If there is no text, reply with nothing.';

export async function ocr(bytes: Uint8Array, mimeType: string, fileName: string): Promise<{ text: string; model: string; usage: Usage | null }> {
  const provider = envStr("OCR_PROVIDER", "").toLowerCase();
  const model = env("OCR_MODEL");
  if (!provider || !model) throw new ProviderError("OCR is not set up (OCR_PROVIDER, OCR_MODEL)", undefined, false);
  const data = Buffer.from(bytes).toString("base64");
  const isPdf = mimeType === "application/pdf";
  const timeout = envNum("OCR_TIMEOUT_MS", 120_000);

  const call = async () => {
    if (provider === "anthropic") {
      const base = (env("OCR_BASE_URL") ?? envStr("ANTHROPIC_BASE_URL", "https://api.anthropic.com")).replace(/\/$/, "");
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env("OCR_API_KEY") ?? env("ANTHROPIC_API_KEY") ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          system: PROMPT,
          messages: [
            {
              role: "user",
              content: [
                isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } } : { type: "image", source: { type: "base64", media_type: mimeType, data } },
                { type: "text", text: "Transcribe this." },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(timeout),
      });
      await assertOk(res, "OCR request");
      const j = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
      return {
        text: (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
        usage: j.usage ? { inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens } : null,
      };
    }
    if (provider === "openai") {
      const base = (env("OCR_BASE_URL") ?? envStr("OPENAI_BASE_URL", "https://api.openai.com/v1")).replace(/\/$/, "");
      const part = isPdf
        ? { type: "file", file: { filename: fileName, file_data: `data:application/pdf;base64,${data}` } }
        : { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } };
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env("OCR_API_KEY") ?? env("OPENAI_API_KEY") ?? ""}` },
        body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: PROMPT }, { role: "user", content: [part, { type: "text", text: "Transcribe this." }] }] }),
        signal: AbortSignal.timeout(timeout),
      });
      await assertOk(res, "OCR request");
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
      return {
        text: j.choices?.[0]?.message?.content ?? "",
        usage: j.usage ? { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens } : null,
      };
    }
    throw new ProviderError(`Unknown OCR_PROVIDER "${provider}" (use openai | anthropic)`, undefined, false);
  };

  const r = await withRetries(call, { attempts: 3 });
  return { text: r.text.trim(), model: `${provider}:${model}`, usage: r.usage };
}
