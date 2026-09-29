/**
 * The answer-cache key for a question. Pure (no imports) so it is unit-tested. Case, spacing, and punctuation at the
 * edges or between words don't matter ("What are your timings?" = "what are your timings"), but every word, number and
 * script does, so answers are only reused for the same question in the same language.
 */
export function questionKey(text: string): string | null {
  const key = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s.,!?¿¡;:'"“”‘’()[\]{}…।-]+/gu, " ")
    .trim();
  // Very long questions are almost never repeated word for word: don't cache them.
  return key && key.length <= 200 ? key : null;
}
