// Explicit .ts extensions: this file is also loaded directly by the unit tests (Node type stripping).
import { ProviderError, type ChatMessage, type LLMProvider, type Usage } from "./types.ts";
import { envNum } from "../env.ts";

/**
 * Production wrapper around a chat model call:
 *  - a time limit for the first token (LLM_FIRST_TOKEN_TIMEOUT_MS, default 20 s) and for the whole answer
 *    (LLM_TIMEOUT_MS, default 90 s), so a stuck provider can't hang a WhatsApp reply forever
 *  - retries with exponential backoff (LLM_RETRIES, default 2) for rate limits, overload, server errors,
 *    timeouts and dropped connections, but only while nothing has been sent to the customer yet
 *  - then the backup model (LLM_FALLBACK_PROVIDER / LLM_FALLBACK_MODEL), if configured
 * Once text has streamed to the customer a failure is final: retrying would repeat or contradict what they saw.
 */

export class TimeoutError extends ProviderError {
  constructor(what: string) {
    super(`${what} timed out`, undefined, true);
    this.name = "TimeoutError";
  }
}

/** What happened during one answer: filled in as the stream runs, read by the caller for logging and billing. */
export type Run = {
  provider: string;
  model: string;
  attempts: number;
  fallbackUsed: boolean;
  firstTokenMs: number | null;
  usage: Usage | null;
  errors: string[];
};

export const newRun = (): Run => ({ provider: "", model: "", attempts: 0, fallbackUsed: false, firstTokenMs: null, usage: null, errors: [] });

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** 400 ms, 800 ms, 1.6 s... with ±25 % jitter so many clients don't retry in lock-step. */
export const backoffMs = (attempt: number, base = 400) => Math.round(base * 2 ** attempt * (0.75 + Math.random() * 0.5));

export function isRetryable(e: unknown): boolean {
  if (e instanceof ProviderError) return e.retryable;
  // fetch() network failures (DNS, reset connections) surface as TypeError("fetch failed").
  return e instanceof TypeError || (e as Error)?.name === "AbortError";
}

/** Retries a one-shot async call (embeddings, lookups) on retryable errors. */
export async function withRetries<T>(fn: () => Promise<T>, o: { attempts?: number; baseMs?: number } = {}): Promise<T> {
  const attempts = Math.max(1, o.attempts ?? 3);
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !isRetryable(e)) throw e;
      await sleep(backoffMs(i, o.baseMs));
    }
  }
}

export async function* resilientStream(
  o: { system: string; messages: ChatMessage[]; signal?: AbortSignal },
  primary: LLMProvider,
  fallback: LLMProvider | null,
  run: Run
): AsyncGenerator<string> {
  const firstTokenLimit = envNum("LLM_FIRST_TOKEN_TIMEOUT_MS", 20_000);
  const totalLimit = envNum("LLM_TIMEOUT_MS", 90_000);
  const retries = Math.max(0, Math.round(envNum("LLM_RETRIES", 2)));
  const plan: { llm: LLMProvider; tries: number }[] = [{ llm: primary, tries: 1 + retries }, ...(fallback ? [{ llm: fallback, tries: 1 }] : [])];
  const started = Date.now();
  let lastError: unknown = null;

  for (const [step, { llm, tries }] of plan.entries()) {
    for (let t = 0; t < tries; t++) {
      if (o.signal?.aborted) throw o.signal.reason ?? new Error("aborted");
      run.attempts++;
      run.provider = llm.name;
      run.model = llm.model;
      run.fallbackUsed = step > 0;
      const ctrl = new AbortController();
      const onOuterAbort = () => ctrl.abort(o.signal?.reason);
      o.signal?.addEventListener("abort", onOuterAbort, { once: true });
      const firstTimer = setTimeout(() => ctrl.abort(new TimeoutError("Waiting for the first token")), firstTokenLimit);
      const totalTimer = setTimeout(() => ctrl.abort(new TimeoutError("The answer")), totalLimit);
      let yielded = false;
      try {
        for await (const delta of llm.stream({ system: o.system, messages: o.messages, signal: ctrl.signal, onUsage: (u) => (run.usage = u) })) {
          if (ctrl.signal.aborted) throw ctrl.signal.reason;
          if (!yielded) {
            yielded = true;
            clearTimeout(firstTimer);
            run.firstTokenMs = Date.now() - started;
          }
          yield delta;
        }
        if (ctrl.signal.aborted) throw ctrl.signal.reason; // a provider that swallowed the abort
        return;
      } catch (e) {
        const err = ctrl.signal.aborted && !o.signal?.aborted ? (ctrl.signal.reason ?? e) : e;
        if (o.signal?.aborted) throw err; // the visitor left: stop quietly
        run.errors.push(`${llm.name}/${llm.model}: ${(err as Error)?.message ?? String(err)}`.slice(0, 300));
        if (yielded) throw err; // text already reached the customer
        lastError = err;
        if (!isRetryable(err)) break; // e.g. a bad API key: retrying the same model won't help, try the backup
        if (t < tries - 1) await sleep(backoffMs(t), o.signal);
      } finally {
        clearTimeout(firstTimer);
        clearTimeout(totalTimer);
        o.signal?.removeEventListener("abort", onOuterAbort);
      }
    }
  }
  throw lastError ?? new ProviderError("No model is configured");
}
