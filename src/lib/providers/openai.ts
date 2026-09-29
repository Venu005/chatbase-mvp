import { ProviderError, assertOk, estimateTokens, type EmbeddingProvider, type LLMProvider, type StreamOptions } from "./types";
import { sseData } from "./sse";
import { env, envNum, envStr } from "../env";

/** Works with OpenAI and any OpenAI-compatible server (vLLM, Ollama, LiteLLM, Azure/Bedrock gateways, ...). */
export function openAIChat(modelOverride?: string): LLMProvider {
  const base = envStr("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const key = env("OPENAI_API_KEY");
  const model = modelOverride ?? env("LLM_MODEL");
  // Most OpenAI-compatible servers report token usage at the end of a stream when asked; set OPENAI_STREAM_USAGE=false
  // for the few that reject the option.
  const askUsage = env("OPENAI_STREAM_USAGE")?.toLowerCase() !== "false";
  const maxTokens = env("LLM_MAX_TOKENS") ? Number(env("LLM_MAX_TOKENS")) : undefined;
  return {
    name: "openai-compatible",
    model: model ?? "",
    async *stream({ system, messages, temperature = 0.2, signal, onUsage }: StreamOptions) {
      if (!model) throw new ProviderError("LLM_MODEL is not set", undefined, false);
      if (!key) throw new ProviderError("OPENAI_API_KEY is not set", undefined, false);
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature,
          stream: true,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(askUsage ? { stream_options: { include_usage: true } } : {}),
          messages: [{ role: "system", content: system }, ...messages],
        }),
      });
      await assertOk(res, "LLM request");
      if (!res.body) throw new ProviderError("LLM returned no body");
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      let out = "";
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        try {
          const j = JSON.parse(data);
          if (j?.usage) usage = j.usage;
          const delta = j?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            out += delta;
            yield delta;
          }
        } catch {
          /* ignore keep-alives / partial frames */
        }
      }
      onUsage?.(
        usage?.prompt_tokens !== undefined
          ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens ?? 0 }
          : { inputTokens: estimateTokens(system + messages.map((m) => m.content).join("")), outputTokens: estimateTokens(out), estimated: true }
      );
    },
  };
}

export function openAIEmbeddings(dim: number): EmbeddingProvider {
  const base = (env("EMBEDDING_BASE_URL") ?? envStr("OPENAI_BASE_URL", "https://api.openai.com/v1")).replace(/\/$/, "");
  const key = env("EMBEDDING_API_KEY") ?? env("OPENAI_API_KEY");
  const model = envStr("EMBEDDING_MODEL", "text-embedding-3-small");
  const sendDims = env("EMBEDDING_SEND_DIMENSIONS") === "true";
  return {
    name: "openai-compatible",
    model,
    dim,
    async embed(texts: string[]) {
      if (!key) throw new ProviderError("EMBEDDING_API_KEY (or OPENAI_API_KEY) is not set", undefined, false);
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: texts, ...(sendDims ? { dimensions: dim } : {}) }),
        signal: AbortSignal.timeout(envNum("EMBEDDING_TIMEOUT_MS", 30_000)),
      });
      await assertOk(res, "Embedding request");
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const out = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (out.some((v) => v.length !== dim)) {
        throw new ProviderError(
          `Embedding model returned ${out[0]?.length} dims but EMBEDDING_DIM=${dim}. ` +
            `Fix EMBEDDING_DIM and re-run the migration on an empty database.`,
          undefined,
          false
        );
      }
      return out;
    },
  };
}
