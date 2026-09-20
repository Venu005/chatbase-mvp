import type { EmbeddingProvider, LLMProvider } from "./types";

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

export function mockEmbeddings(dim: number): EmbeddingProvider {
  return { name: "mock", dim, embed: async (texts) => texts.map((t) => mockEmbedText(t, dim)) };
}

export function mockChat(): LLMProvider {
  return {
    name: "mock",
    async *stream({ system, messages }) {
      const context = system.match(/<context>\n([\s\S]*?)\n<\/context>/)?.[1] ?? "";
      const first = context.match(/^\[1\][^\n]*\n([\s\S]*?)(?=\n\n\[2\]|$)/);
      const question = messages[messages.length - 1]?.content ?? "";
      const answer = first
        ? `(mock model) Based on your sources: ${first[1].trim().slice(0, 400)} [1]`
        : `(mock model) I don't have information about "${question.slice(0, 60)}" in my sources yet.`;
      for (const word of answer.split(/(\s+)/)) {
        yield word;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}
