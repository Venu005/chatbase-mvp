import type { LLMProvider, StreamOptions } from "./types";
import { normalizeTurns } from "./turns";
import { sseData } from "./sse";
import { createThinkFilter } from "./think";
import { env, envNum, envStr } from "../env";

/**
 * Sarvam AI (Indian-language models). Chat completions are OpenAI-style: POST {base}/chat/completions with
 * the key in the `api-subscription-key` header. Sarvam has no embeddings API, so pair it with an embedding
 * provider (EMBEDDING_PROVIDER=openai works with OpenAI or any OpenAI-compatible multilingual model).
 * Docs: https://docs.sarvam.ai/api-reference/chat/chat-completions
 */

export function sarvamChat(): LLMProvider {
  const base = envStr("SARVAM_BASE_URL", "https://api.sarvam.ai/v1").replace(/\/$/, "");
  const key = env("SARVAM_API_KEY");
  const model = envStr("LLM_MODEL", "sarvam-105b");
  const effort = envStr("SARVAM_REASONING_EFFORT", "").toLowerCase(); // "", none | low | medium | high
  const maxTokens = envNum("SARVAM_MAX_TOKENS", 1024);
  return {
    name: "sarvam",
    async *stream({ system, messages, temperature = 0.2, signal }: StreamOptions) {
      if (!key) throw new Error("SARVAM_API_KEY is not set");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "api-subscription-key": key },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          // Reasoning adds latency and cost; a support bot answering from retrieved passages rarely needs it.
          ...(effort === "none" || effort === "off" ? { reasoning_effort: null } : ["low", "medium", "high"].includes(effort) ? { reasoning_effort: effort } : {}),
          messages: [{ role: "system", content: system }, ...normalizeTurns(messages)],
        }),
      });
      if (!res.ok || !res.body) throw new Error(`Sarvam request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const think = createThinkFilter();
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        try {
          const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            const visible = think.push(delta);
            if (visible) yield visible;
          }
        } catch {
          /* ignore keep-alives / partial frames */
        }
      }
      const rest = think.flush();
      if (rest) yield rest;
    },
  };
}
