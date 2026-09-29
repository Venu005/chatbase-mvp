export type ChatMessage = { role: "user" | "assistant"; content: string };

/** Tokens one model call used. `estimated` when the provider didn't report them (≈ 4 characters per token). */
export type Usage = { inputTokens: number; outputTokens: number; estimated?: boolean };

export type StreamOptions = {
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  /** Called once, at the end of a successful call, with the tokens it used. */
  onUsage?: (usage: Usage) => void;
};

/** A chat model. Implement this to add a new provider (Sarvam, Bedrock, Ollama...). */
export interface LLMProvider {
  name: string;
  model: string;
  stream(opts: StreamOptions): AsyncGenerator<string>;
}

export interface EmbeddingProvider {
  name: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * A failed provider call. `status` is the HTTP status when there was one; `retryable` says whether trying again
 * can help (rate limits, overload, server errors, timeouts, dropped connections) as opposed to a bad key or request.
 */
export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, status?: number, retryable?: boolean) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable ?? (status === undefined || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
  }
}

/** Throws a ProviderError for a non-OK response (reads a short piece of the body for the message). */
export async function assertOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new ProviderError(`${what} failed (${res.status}): ${body.slice(0, 300)}`, res.status);
}

/** Rough token count for providers that don't report usage. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
