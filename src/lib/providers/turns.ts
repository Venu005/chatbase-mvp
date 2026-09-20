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
