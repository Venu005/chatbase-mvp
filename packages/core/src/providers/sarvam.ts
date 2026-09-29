import { ProviderError, assertOk, estimateTokens, type LLMProvider, type StreamOptions } from "./types";
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

export function sarvamChat(modelOverride?: string): LLMProvider {
  const base = envStr("SARVAM_BASE_URL", "https://api.sarvam.ai/v1").replace(/\/$/, "");
  const key = env("SARVAM_API_KEY");
  const model = modelOverride ?? envStr("LLM_MODEL", "sarvam-105b");
  const effort = envStr("SARVAM_REASONING_EFFORT", "").toLowerCase(); // "", none | low | medium | high
  const maxTokens = envNum("SARVAM_MAX_TOKENS", 1024);
  return {
    name: "sarvam",
    model,
    async *stream({ system, messages, temperature = 0.2, signal, onUsage }: StreamOptions) {
      if (!key) throw new ProviderError("SARVAM_API_KEY is not set", undefined, false);
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
      await assertOk(res, "Sarvam request");
      if (!res.body) throw new ProviderError("Sarvam returned no body");
      const think = createThinkFilter();
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      let raw = "";
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        try {
          const j = JSON.parse(data);
          if (j?.usage) usage = j.usage;
          const delta = j?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            raw += delta;
            const visible = think.push(delta);
            if (visible) yield visible;
          }
        } catch {
          /* ignore keep-alives / partial frames */
        }
      }
      const rest = think.flush();
      if (rest) yield rest;
      onUsage?.(
        usage?.prompt_tokens !== undefined
          ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens ?? 0 }
          : { inputTokens: estimateTokens(system + messages.map((m) => m.content).join("")), outputTokens: estimateTokens(raw), estimated: true }
      );
    },
  };
}
