import type { LLMProvider, StreamOptions } from "./types";
import { sseData } from "./sse";
import { env, envStr } from "../env";

export function anthropicChat(): LLMProvider {
  const base = envStr("ANTHROPIC_BASE_URL", "https://api.anthropic.com").replace(/\/$/, "");
  const key = env("ANTHROPIC_API_KEY");
  const model = env("LLM_MODEL");
  return {
    name: "anthropic",
    async *stream({ system, messages, temperature = 0.2, signal }: StreamOptions) {
      if (!model) throw new Error("LLM_MODEL is not set");
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: 1024, temperature, stream: true, system, messages }),
      });
      if (!res.ok || !res.body) throw new Error(`LLM request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      for await (const data of sseData(res.body)) {
        try {
          const ev = JSON.parse(data);
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) yield ev.delta.text;
          if (ev.type === "error") throw new Error(ev.error?.message ?? "LLM stream error");
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    },
  };
}
