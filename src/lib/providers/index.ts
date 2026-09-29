import { ProviderError, type EmbeddingProvider, type LLMProvider } from "./types";
import { openAIChat, openAIEmbeddings } from "./openai";
import { anthropicChat } from "./anthropic";
import { sarvamChat } from "./sarvam";
import { mockChat, mockEmbeddings } from "./mock";
import { withRetries } from "./resilient";
import { env, envNum, envStr } from "../env";

export const EMBEDDING_DIM = envNum("EMBEDDING_DIM", 1536);

function makeLLM(provider: string, model?: string): LLMProvider {
  switch (provider.toLowerCase()) {
    case "openai":
      return openAIChat(model);
    case "anthropic":
      return anthropicChat(model);
    case "sarvam":
      return sarvamChat(model);
    case "mock":
      return mockChat(model);
    default:
      throw new Error(`Unknown LLM provider "${provider}" (use mock | openai | anthropic | sarvam)`);
  }
}

/** The main chat model (LLM_PROVIDER / LLM_MODEL). */
export function getLLM(): LLMProvider {
  return makeLLM(envStr("LLM_PROVIDER", "mock"));
}

/**
 * Optional backup chat model, used when the main one keeps failing before it answers: LLM_FALLBACK_PROVIDER and
 * LLM_FALLBACK_MODEL (e.g. openai + a small model, while the main model is anthropic). Null when not configured.
 */
export function getFallbackLLM(): LLMProvider | null {
  const provider = env("LLM_FALLBACK_PROVIDER");
  return provider ? makeLLM(provider, env("LLM_FALLBACK_MODEL")) : null;
}

export function getEmbedder(): EmbeddingProvider {
  let inner: EmbeddingProvider;
  switch (envStr("EMBEDDING_PROVIDER", "mock").toLowerCase()) {
    case "openai":
      inner = openAIEmbeddings(EMBEDDING_DIM);
      break;
    case "mock":
      inner = mockEmbeddings(EMBEDDING_DIM);
      break;
    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER "${process.env.EMBEDDING_PROVIDER}" (use mock | openai)`);
  }
  // Rate limits and blips are common on bulk embedding: retry them with backoff.
  return { ...inner, embed: (texts) => withRetries(() => inner.embed(texts), { attempts: 1 + envNum("EMBEDDING_RETRIES", 3) }) };
}

/** "openai:text-embedding-3-small": stored on every passage so a model change can be detected. */
export const embeddingModelId = () => {
  const e = getEmbedder();
  return `${e.name === "openai-compatible" ? "openai" : e.name}:${e.model}`;
};

/** Embeds any number of texts, batching requests. */
export async function embedAll(texts: string[], batch = 64): Promise<number[][]> {
  const embedder = getEmbedder();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    out.push(...(await embedder.embed(texts.slice(i, i + batch))));
  }
  return out;
}

export { ProviderError };
