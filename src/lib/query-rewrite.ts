import { env, envNum } from "./env";
import { makeLLM } from "./providers";
import type { ChatMessage, Usage } from "./providers/types";

/**
 * Optional (QUERY_REWRITE=on): turns a follow-up like "and the 10 kg one?" into a standalone search query
 * ("price of Aashirvaad atta 10 kg") with a small model, before retrieval. Only runs when there is earlier conversation.
 * QUERY_REWRITE_PROVIDER / QUERY_REWRITE_MODEL pick the model (default: the main one); QUERY_REWRITE_TIMEOUT_MS
 * (default 2.5 s) bounds the delay. On any failure the caller keeps its simple approach (previous question + message).
 */
export const queryRewriteEnabled = () => env("QUERY_REWRITE")?.toLowerCase() === "on";

const SYSTEM =
  "Rewrite the customer's latest message as one standalone search query for a shop's knowledge base, using the " +
  "earlier conversation only to fill in what the latest message refers to. Keep product names, numbers and the " +
  "customer's language and script. Reply with the query only, no quotes or explanation.";

export async function rewriteFollowUp(history: ChatMessage[], message: string): Promise<{ query: string; model: string; usage: Usage | null } | null> {
  const llm = makeLLM(env("QUERY_REWRITE_PROVIDER") ?? env("LLM_PROVIDER") ?? "mock", env("QUERY_REWRITE_MODEL"));
  const convo = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content.slice(0, 500)}`)
    .join("\n");
  let out = "";
  let usage: Usage | null = null;
  try {
    for await (const d of llm.stream({
      system: SYSTEM,
      messages: [{ role: "user", content: `${convo}\nCustomer (latest): ${message}` }],
      temperature: 0,
      signal: AbortSignal.timeout(envNum("QUERY_REWRITE_TIMEOUT_MS", 2500)),
      onUsage: (u) => (usage = u),
    }))
      out += d;
  } catch (e) {
    console.error("Query rewrite failed, using the simple follow-up query:", (e as Error).message);
    return null;
  }
  const query = out.trim().split("\n")[0].replace(/^["'“]|["'”]$/g, "").slice(0, 300);
  return query ? { query, model: `${llm.name}:${llm.model}`, usage } : null;
}
