import { ProviderError, estimateTokens, type EmbeddingProvider, type LLMProvider } from "./types";

// ---------------------------------------------------------------------------
// Offline providers for local development and tests. They need no API keys.
// The mock embedding is feature-hashed bag-of-words: it matches on shared
// words, NOT on meaning. Use a real embedding model for anything real.
// ---------------------------------------------------------------------------

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mockEmbedText(text: string, dim: number): number[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < words.length; i++) {
    v[fnv1a(words[i]) % dim] += 1;
    if (i > 0) v[fnv1a(words[i - 1] + " " + words[i]) % dim] += 0.5;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

// Fault injection for tests: a text containing [[mock:embed-fail-N]] makes the first N embedding calls for that text fail
// (503). Keyed by the whole text, so tests can repeat against the same server by varying the text.
const embedFailures = new Map<string, number>();

export function mockEmbeddings(dim: number): EmbeddingProvider {
  return {
    name: "mock",
    model: "mock-embed",
    dim,
    embed: async (texts) => {
      for (const t of texts) {
        const m = t.match(/\[\[mock:embed-fail-(\d+)\]\]/);
        if (m && (embedFailures.get(t) ?? 0) < Number(m[1])) {
          embedFailures.set(t, (embedFailures.get(t) ?? 0) + 1);
          throw new ProviderError("Mock embedding failure", 503);
        }
      }
      return texts.map((t) => mockEmbedText(t, dim));
    },
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason ?? new Error("aborted"))), { once: true });
  });

// Fault injection for tests (only the mock does this): a question containing
//   [[mock:fail-429x2]]  fails with HTTP 429 on the first 2 calls for that question, then answers
//   [[mock:fail-500]]    always fails with HTTP 500 (the fallback model, if configured, answers)
//   [[mock:hang]]        never produces a first token (tests the first-token timeout)
//   [[mock:break]]       sends a few words, then fails (a mid-answer failure can't be retried)
const failures = new Map<string, number>();

export function mockChat(model = "mock"): LLMProvider {
  const isFallback = model !== "mock";
  return {
    name: "mock",
    model,
    async *stream({ system, messages, signal, onUsage }) {
      const question = messages[messages.length - 1]?.content ?? "";
      if (!isFallback) {
        const n = question.match(/\[\[mock:fail-(\d{3})(?:x(\d+))?\]\]/);
        if (n) {
          const used = failures.get(question) ?? 0;
          if (!n[2] || used < Number(n[2])) {
            failures.set(question, used + 1);
            throw new ProviderError(`Mock failure (${n[1]})`, Number(n[1]));
          }
        }
        if (question.includes("[[mock:hang]]")) await sleep(10 * 60_000, signal);
      }

      let answer: string;
      // Follow-up rewriting (QUERY_REWRITE=on): the mock just joins the previous and latest customer messages.
      if (system.startsWith("Rewrite the customer's latest message")) {
        const lines = question.split("\n");
        const latest = lines.pop()!.replace(/^Customer \(latest\): /, "");
        const prev = lines.reverse().find((l) => l.startsWith("Customer: "))?.slice(10) ?? "";
        const q = `${prev} ${latest}`.trim();
        yield q;
        onUsage?.({ inputTokens: estimateTokens(system + question), outputTokens: estimateTokens(q), estimated: true });
        return;
      }
      // Owner-written Q&A fixes win, as the real prompt instructs.
      const verified = system.match(/<verified_answers>\nQ: [^\n]*\nA: ([\s\S]*?)(?=\n\nQ: |\n<\/verified_answers>)/)?.[1];
      if (verified) answer = `(mock model) ${verified.trim()}`;
      else {
        const context = system.match(/<context>\n([\s\S]*?)\n<\/context>/)?.[1] ?? "";
        const first = context.match(/^\[1\][^\n]*\n([\s\S]*?)(?=\n\n\[2\]|$)/);
        answer = first
          ? `(mock model) Based on your sources: ${first[1].trim().slice(0, 400)} [1]`
          : `(mock model) I don't have information about "${question.slice(0, 60)}" in my sources yet.`;
      }
      if (isFallback) answer = answer.replace("(mock model)", `(mock ${model})`); // e.g. "(mock backup)", "(mock small)"

      let sent = 0;
      for (const word of answer.split(/(\s+)/)) {
        if (!isFallback && question.includes("[[mock:break]]") && sent++ === 4) throw new ProviderError("Mock stream broke", 502);
        yield word;
        await sleep(5, signal);
      }
      onUsage?.({ inputTokens: estimateTokens(system + messages.map((m) => m.content).join("")), outputTokens: estimateTokens(answer), estimated: true });
    },
  };
}
