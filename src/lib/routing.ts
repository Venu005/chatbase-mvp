/**
 * Which model a message needs. Pure (no imports) so it is unit-tested.
 * - Small talk ("hi", "thanks", "ok", "dhanyavaad", "नमस्ते") needs no search at all, and isn't a knowledge gap.
 * - Small talk, and questions where one of the owner's Q&A answers matched closely (the answer is essentially written
 *   already), can go to a cheaper model (LLM_SMALL_PROVIDER / LLM_SMALL_MODEL) when one is configured.
 */

const SMALL_TALK = new RegExp(
  "^(?:" +
    [
      "h+i+|hello+|hey+|hii+|hola|namaste|namaskar|good (?:morning|afternoon|evening|night)|gm|yo",
      "thanks?|thank you|thank u|thanx|thnx|ty|tysm|many thanks|thanks a lot|dhanyavaad|dhanyavad|dhanyawad|shukriya|shukria",
      "ok+|okay|okk+|k|fine|cool|great|nice|got it|sure|alright|done|perfect|awesome|super",
      "bye+|goodbye|see you|tata|alvida|good bye",
      "नमस्ते|नमस्कार|धन्यवाद|शुक्रिया|ठीक है|ओके|अलविदा",
    ].join("|") +
    ")(?:\\s+(?:sir|madam|ji|bhai|bro|dear|team|again|so much|a lot|very much))*[\\s!.🙏😊👍🙂]*$",
  "iu"
);

export const isSmallTalk = (message: string) => SMALL_TALK.test(message.trim());

export type Route = "main" | "small";

/** A Q&A answer this close (0 to 1) to the question counts as "the answer is already written" (ROUTE_FIX_SCORE). */
export function route(message: string, bestFixScore: number | null, fixThreshold = 0.8): Route {
  if (isSmallTalk(message)) return "small";
  if (bestFixScore !== null && bestFixScore >= fixThreshold) return "small";
  return "main";
}
