import type { EmbeddingProvider, LLMProvider, StreamOptions } from "./types";
import { sseData } from "./sse";
import { env, envStr } from "../env";

/** Works with OpenAI and any OpenAI-compatible server (vLLM, Ollama, LiteLLM, Azure/Bedrock gateways, ...). */
export function openAIChat(): LLMProvider {
  const base = envStr("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const key = env("OPENAI_API_KEY");
  const model = env("LLM_MODEL");
  return {
    name: "openai-compatible",
    async *stream({ system, messages, temperature = 0.2, signal }: StreamOptions) {
      if (!model) throw new Error("LLM_MODEL is not set");
      if (!key) throw new Error("OPENAI_API_KEY is not set");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature,
          stream: true,
          messages: [{ role: "system", content: system }, ...messages],
        }),
      });
      if (!res.ok || !res.body) throw new Error(`LLM request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") return;
        try {
          const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) yield delta;
        } catch {
          /* ignore keep-alives / partial frames */
        }
      }
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
    dim,
    async embed(texts: string[]) {
      if (!key) throw new Error("EMBEDDING_API_KEY (or OPENAI_API_KEY) is not set");
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: texts, ...(sendDims ? { dimensions: dim } : {}) }),
      });
      if (!res.ok) throw new Error(`Embedding request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const out = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (out.some((v) => v.length !== dim)) {
        throw new Error(
          `Embedding model returned ${out[0]?.length} dims but EMBEDDING_DIM=${dim}. ` +
            `Fix EMBEDDING_DIM and re-run the migration on an empty database.`
        );
      }
      return out;
    },
  };
}
