/**
 * Scoring helpers for the answer-quality evaluation (scripts/eval.ts). Pure (no imports) so they are unit-tested.
 */

/** Lower-case, Unicode-normalised, "₹2,000" → "₹2000", collapsed spaces: so checks don't fail on formatting. */
export function normalize(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/(\d),(?=\d{2,3}\b)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export const containsAny = (text: string, needles: string[] = []) => needles.some((n) => normalize(text).includes(normalize(n)));

const REFUSAL =
  /don['’]?t have|do not have|not (sure|able|available)|no information|couldn['’]?t find|can['’]?t (help|find|answer)|cannot (help|answer|find)|unable to|contact (the )?(business|us|store|shop|team)|(talk|speak) to a (person|human)|जानकारी नहीं|पता नहीं|nahi (pata|hai|milta|milega)|maaf|sorry/i;

/** Does the answer decline (as it should for questions the sources don't cover)? */
export const isRefusal = (text: string) => REFUSAL.test(text);

/** Main script of a text: "devanagari" when at least 30 % of its letters are Devanagari, else "latin". */
export function script(text: string): "devanagari" | "latin" {
  const letters = text.match(/\p{L}/gu) ?? [];
  const deva = letters.filter((c) => /\p{Script=Devanagari}/u.test(c)).length;
  return letters.length && deva / letters.length >= 0.3 ? "devanagari" : "latin";
}

/** Script the reply should use for a question in this language (Hinglish is Hindi in Latin letters). */
export const expectedScript = (lang: "en" | "hi" | "hinglish") => (lang === "hi" ? "devanagari" : "latin");

/** 1-based rank of the first passage containing `needle`, or 0 if none does. */
export function rankOf(passages: string[], needle: string): number {
  const i = passages.findIndex((p) => normalize(p).includes(normalize(needle)));
  return i + 1;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export type Summary = Record<string, number | null>;

/** Metrics that got worse than the baseline by more than `tolerance` (0.05 = 5 points). Higher is better for all rates. */
export function regressions(current: Summary, baseline: Summary, tolerance = 0.05): string[] {
  const out: string[] = [];
  for (const [k, base] of Object.entries(baseline)) {
    const now = current[k];
    if (typeof base !== "number" || typeof now !== "number" || !k.endsWith("_rate")) continue;
    if (now < base - tolerance) out.push(`${k}: ${(base * 100).toFixed(1)}% → ${(now * 100).toFixed(1)}%`);
  }
  return out;
}
