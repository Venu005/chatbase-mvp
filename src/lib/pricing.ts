/**
 * Model prices, from settings (they change too often to hard-code). Pure (no imports) so it is unit-tested.
 *   LLM_PRICES="gpt-4.1-mini=0.40/1.60, claude-haiku-4-5=1/5"   USD per million input/output tokens, by model id
 *   EMBEDDING_PRICE_PER_MTOK=0.02                                USD per million embedded tokens
 * A model without a price gets cost NULL (the admin view shows tokens and says the price is missing). Mock models are free.
 */

export type Price = { input: number; output: number };

export function parsePrices(spec: string | undefined): Map<string, Price> {
  const out = new Map<string, Price>();
  for (const part of (spec ?? "").split(",")) {
    const m = part.trim().match(/^([^=\s]+)\s*=\s*([\d.]+)\s*\/\s*([\d.]+)$/);
    if (m) out.set(m[1].toLowerCase(), { input: Number(m[2]), output: Number(m[3]) });
  }
  return out;
}

/** Cost in USD, or null when the model has no configured price. */
export function costUsd(prices: Map<string, Price>, provider: string, model: string, inputTokens: number, outputTokens: number): number | null {
  if (provider === "mock") return 0;
  const p = prices.get(model.toLowerCase());
  if (!p) return null;
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * 1e6) / 1e6;
}

export function embeddingCostUsd(pricePerMTok: number | undefined, provider: string, tokens: number): number | null {
  if (provider === "mock") return 0;
  if (pricePerMTok === undefined || !Number.isFinite(pricePerMTok)) return null;
  return Math.round(((tokens * pricePerMTok) / 1_000_000) * 1e6) / 1e6;
}
