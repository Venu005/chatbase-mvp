export type ChatMessage = { role: "user" | "assistant"; content: string };

export type StreamOptions = {
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
};

/** A chat model. Implement this to add a new provider (Sarvam, Bedrock, Ollama...). */
export interface LLMProvider {
  name: string;
  stream(opts: StreamOptions): AsyncGenerator<string>;
}

export interface EmbeddingProvider {
  name: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
