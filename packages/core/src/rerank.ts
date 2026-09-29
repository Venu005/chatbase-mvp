// Explicit .ts extension: also loaded directly by the unit tests.
import { env, envNum, envStr } from "./env.ts";

/**
 * Optional reranking with a cross-encoder API (Cohere or Jina, or anything with the same /rerank shape):
 *   RERANK_API_KEY, RERANK_MODEL (e.g. rerank-v3.5, or jina-reranker-v2-base-multilingual),
 *   RERANK_BASE_URL (default https://api.cohere.com/v2; Jina: https://api.jina.ai/v1)
 * It reorders the fused candidates by how well each actually answers the question. Off unless configured; any failure
 * or a slow reply (RERANK_TIMEOUT_MS, default 3 s) falls back to the fused order, so it can never break an answer.
 */
export const rerankConfigured = () => !!(env("RERANK_API_KEY") && env("RERANK_MODEL"));

/** Indices of `docs` in reranked order (best first, at most topN), or null to keep the original order. */
export async function rerank(query: string, docs: string[], topN: number): Promise<number[] | null> {
  if (!rerankConfigured() || docs.length < 2) return null;
  try {
    const res = await fetch(`${envStr("RERANK_BASE_URL", "https://api.cohere.com/v2").replace(/\/$/, "")}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env("RERANK_API_KEY")}` },
      body: JSON.stringify({ model: env("RERANK_MODEL"), query, documents: docs, top_n: Math.min(topN, docs.length) }),
      signal: AbortSignal.timeout(envNum("RERANK_TIMEOUT_MS", 3000)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
    const order = (j.results ?? []).filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < docs.length).map((r) => r.index);
    return order.length ? order : null;
  } catch (e) {
    console.error("Rerank failed, keeping the fused order:", (e as Error).message);
    return null;
  }
}
