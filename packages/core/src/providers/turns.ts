import type { ChatMessage } from "./types";

/**
 * Some chat endpoints reject histories that don't strictly alternate user/assistant or that start with an
 * assistant turn. Human handoff can produce such histories (owner reply + bot reply, unanswered messages),
 * so merge consecutive same-role turns and drop leading assistant turns.
 */
export function normalizeTurns(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!m.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else if (last || m.role === "user") out.push({ ...m });
  }
  return out;
}

/**
 * Keeps the newest turns that fit in `maxChars` (HISTORY_MAX_CHARS, default 6,000 characters, about 1,500 tokens),
 * each turn capped at 1,500 characters, so a few long messages can't blow the model's context or the bill.
 */
export function trimHistory(prior: ChatMessage[], maxChars: number): ChatMessage[] {
  let budget = maxChars;
  const out: ChatMessage[] = [];
  for (let i = prior.length - 1; i >= 0 && budget > 0; i--) {
    const m = prior[i];
    const content = m.content.length > 1500 ? `${m.content.slice(0, 1500)}…` : m.content;
    if (content.length > budget) break;
    budget -= content.length;
    out.unshift({ role: m.role, content });
  }
  return out;
}
