import { ProviderError, assertOk, type LLMProvider, type StreamOptions } from "./types";
import { sseData } from "./sse";
import { normalizeTurns } from "./turns";
import { env, envNum, envStr } from "../env";

export function anthropicChat(modelOverride?: string): LLMProvider {
  const base = envStr("ANTHROPIC_BASE_URL", "https://api.anthropic.com").replace(/\/$/, "");
  const key = env("ANTHROPIC_API_KEY");
  const model = modelOverride ?? env("LLM_MODEL");
  const maxTokens = envNum("LLM_MAX_TOKENS", 1024);
  return {
    name: "anthropic",
    model: model ?? "",
    async *stream({ system, messages, temperature = 0.2, signal, onUsage }: StreamOptions) {
      if (!model) throw new ProviderError("LLM_MODEL is not set", undefined, false);
      if (!key) throw new ProviderError("ANTHROPIC_API_KEY is not set", undefined, false);
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, stream: true, system, messages: normalizeTurns(messages) }),
      });
      await assertOk(res, "LLM request");
      if (!res.body) throw new ProviderError("LLM returned no body");
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const data of sseData(res.body)) {
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue; // keep-alive / partial frame
        }
        if (ev.type === "message_start") inputTokens = ev.message?.usage?.input_tokens ?? 0;
        else if (ev.type === "message_delta" && ev.usage?.output_tokens !== undefined) outputTokens = ev.usage.output_tokens;
        else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) yield ev.delta.text;
        // Errors inside the stream (e.g. "overloaded_error") come as an event, not an HTTP status.
        else if (ev.type === "error") throw new ProviderError(ev.error?.message ?? "LLM stream error", ev.error?.type === "overloaded_error" ? 529 : undefined);
      }
      onUsage?.({ inputTokens, outputTokens });
    },
  };
}
