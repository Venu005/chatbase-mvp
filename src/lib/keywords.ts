/**
 * Builds the keyword half of hybrid search from a visitor's message. Pure (no imports) so it is unit-tested.
 * - keeps words, numbers and product codes (AM-B500), in any script
 * - drops filler words (English, Hinglish, Hindi) that would match every passage
 * - adds English equivalents for common Hinglish support words ("atta ka rate" also searches "price"), because many
 *   sources are in English while customers type Hindi in Latin letters
 * - prefix-matches words of 4+ letters, so "sunday" also finds "Sundays"
 */

const STOP = new Set(
  (
    "a about an and any are as at be by can could do does for from get got have how i if in is it its like many me much my of on or our please some " +
    "so tell than that the their them there this to u us was we what when where which who will with would you your " +
    "hai hain kya ka ki ke ko se mein me main mai hum aap aapke aapka apna bhi to toh na nahi ho hota hoti tha thi " +
    "kaise kaisa kitna kitne kitni kab kahan kya kyun yeh ye woh wo koi kuch aur ya " +
    "है हैं क्या का की के को से में मैं हम आप आपके भी तो ना नहीं हो कैसे कितना कितने कब कहाँ यह वह कोई कुछ और या"
  ).split(/\s+/)
);

/** Hinglish word → English words to search as well. */
const HINGLISH: Record<string, string[]> = {
  rate: ["price"], daam: ["price"], dam: ["price"], keemat: ["price"], kimat: ["price"], mehenga: ["price"], sasta: ["price"],
  dukaan: ["shop", "store"], dukan: ["shop", "store"],
  khulti: ["open"], khulta: ["open"], khula: ["open"], khulega: ["open"], khulegi: ["open"], band: ["closed", "close"],
  baje: ["am", "pm", "hours"], samay: ["time", "hours"], time: ["hours"], timing: ["hours"],
  ghanta: ["hours"], ghante: ["hours"], din: ["days"], dino: ["days"],
  milta: ["available"], milti: ["available"], milega: ["available"], milegi: ["available"],
  wapas: ["return", "refund"], wapsi: ["return", "refund"], vapas: ["return", "refund"], vapsi: ["return", "refund"], paisa: ["refund", "price"], paise: ["refund", "price"],
  bhejo: ["deliver", "delivery"], bhejenge: ["deliver", "delivery"], ghar: ["home", "delivery"], pahuncha: ["deliver"], hogi: [], hoga: [],
  aata: ["atta"], chawal: ["rice"], tel: ["oil"], doodh: ["milk"], dudh: ["milk"], namak: ["salt"], daal: ["dal"], makkhan: ["butter"],
  chhoot: ["offer", "discount"], chhut: ["offer", "discount"], nakad: ["cash"], udhaar: ["credit"],
};

const WORD = /[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*/gu;

/** The message's meaningful words, each with the alternatives that also count (its English equivalents). */
export function keywordGroups(text: string, max = 10): string[][] {
  const words = (text.toLowerCase().normalize("NFC").match(WORD) ?? []).filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    groups.push([w, ...(HINGLISH[w] ?? [])]);
  }
  return groups.slice(0, max);
}

export function keywordTerms(text: string): string[] {
  return [...new Set(keywordGroups(text).flat())];
}

/**
 * Share of the message's meaningful words that a passage contains (a word counts if it or one of its English
 * equivalents appears; words of 4+ letters also match as a prefix, like the search does). Keyword-only matches need a
 * decent share, so "a good pizza place nearby" doesn't pull in "orders placed after 8pm".
 */
export function keywordCoverage(text: string, passage: string): number {
  const groups = keywordGroups(text);
  if (!groups.length) return 0;
  const tokens = new Set(passage.toLowerCase().normalize("NFC").match(WORD) ?? []);
  for (const t of [...tokens]) for (const part of t.split("-")) tokens.add(part);
  const has = (term: string) => tokens.has(term) || ([...term].length >= 4 && !/\d/.test(term) && [...tokens].some((t) => t.startsWith(term)));
  return groups.filter((g) => g.some(has)).length / groups.length;
}

/** A to_tsquery('simple', …) string that matches passages containing ANY of the terms, or null when there are none. */
export function keywordQuery(text: string): string | null {
  const terms = keywordTerms(text);
  if (!terms.length) return null;
  return terms.map((t) => `'${t.replace(/'/g, "''")}'${[...t].length >= 4 && !/\d/.test(t) ? ":*" : ""}`).join(" | ");
}

/**
 * Reciprocal rank fusion: merges ranked lists (vector, keyword) into one. An item's score is the sum over lists of
 * 1 / (k + rank), so something ranked well by both beats something ranked first by only one. k = 60 is the usual value.
 */
export function fuse<T>(lists: T[][], key: (x: T) => string | number, k = 60): { item: T; score: number; in: number[] }[] {
  const acc = new Map<string | number, { item: T; score: number; in: number[] }>();
  lists.forEach((list, li) =>
    list.forEach((x, rank) => {
      const id = key(x);
      const e = acc.get(id) ?? { item: x, score: 0, in: [] };
      e.score += 1 / (k + rank + 1);
      e.in.push(li);
      acc.set(id, e);
    })
  );
  return [...acc.values()].sort((a, b) => b.score - a.score);
}
