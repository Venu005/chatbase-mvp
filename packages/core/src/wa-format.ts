import type { Citation } from "./rag";

// Pure formatting helpers for WhatsApp (kept dependency-free so they can be unit-tested directly).

const MAX_LEN = 4000; // WhatsApp text limit is 4096 characters

/** Turns a model answer into WhatsApp-friendly text: no [1] markers, WhatsApp-style bold, sources appended. */
export function formatForWhatsApp(answer: string, citations: Citation[]): string[] {
  let t = answer
    .replace(/\s*\[\d{1,2}\]/g, "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
  const urls = [...new Set(citations.map((c) => c.url).filter((u): u is string => !!u))].slice(0, 2);
  if (urls.length) t += `\n\nMore info: ${urls.join("\n")}`;

  const parts: string[] = [];
  while (t.length > MAX_LEN) {
    let cut = t.lastIndexOf("\n\n", MAX_LEN);
    if (cut < MAX_LEN / 2) cut = t.lastIndexOf(" ", MAX_LEN);
    if (cut < MAX_LEN / 2) cut = MAX_LEN;
    parts.push(t.slice(0, cut).trim());
    t = t.slice(cut).trim();
  }
  if (t) parts.push(t);
  return parts.length ? parts : ["…"];
}

