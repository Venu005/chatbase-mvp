import type { EmbeddingProvider, LLMProvider } from "./types";
import { openAIChat, openAIEmbeddings } from "./openai";
import { anthropicChat } from "./anthropic";
import { sarvamChat } from "./sarvam";
import { mockChat, mockEmbeddings } from "./mock";
import { envNum, envStr } from "../env";

export const EMBEDDING_DIM = envNum("EMBEDDING_DIM", 1536);

export function getLLM(): LLMProvider {
  switch (envStr("LLM_PROVIDER", "mock").toLowerCase()) {
    case "openai":
      return openAIChat();
    case "anthropic":
      return anthropicChat();
    case "sarvam":
      return sarvamChat();
    case "mock":
      return mockChat();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${process.env.LLM_PROVIDER}" (use mock | openai | anthropic | sarvam)`);
  }
}

export function getEmbedder(): EmbeddingProvider {
  switch (envStr("EMBEDDING_PROVIDER", "mock").toLowerCase()) {
    case "openai":
      return openAIEmbeddings(EMBEDDING_DIM);
    case "mock":
      return mockEmbeddings(EMBEDDING_DIM);
    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER "${process.env.EMBEDDING_PROVIDER}" (use mock | openai)`);
  }
}

/** Embeds any number of texts, batching requests. */
export async function embedAll(texts: string[], batch = 64): Promise<number[][]> {
  const embedder = getEmbedder();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    out.push(...(await embedder.embed(texts.slice(i, i + batch))));
  }
  return out;
}
