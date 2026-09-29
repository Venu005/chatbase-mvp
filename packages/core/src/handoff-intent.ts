/**
 * Does this message ask for a real person? Pure function (no imports) so it is unit-tested.
 * Covers English, Hindi (Devanagari) and Hinglish. It is intentionally a bit conservative: a missed
 * phrase is covered by the widget's "Talk to a human" button, and a false positive just alerts the owner.
 */

const EN_VERB_TARGET =
  /\b(talk|speak|chat|connect|transfer|escalate|forward|put me through|get me)\b[^.?!\n]{0,30}\b(human|real person|person|people|agent|representative|rep|someone|somebody|staff|manager|owner|team|executive|customer (?:care|service|support))\b/i;
const EN_LIVE = /\b(human|live|real)\s+(agent|person|being|support|representative)\b/i;
const EN_CALL = /\b(call me|call back|callback|phone me)\b/i;
const EN_ALONE = /^\s*(human|agent|human agent|live agent|operator|representative|talk to human|talk to a human)\s*[.!?]*\s*$/i;

const HI_TARGET = "(?:इंसान|इन्सान|व्यक्ति|आदमी|एजेंट|एजेन्ट|मैनेजर|मालिक|ओनर|कस्टमर केयर|कस्टमर सर्विस|स्टाफ|टीम)";
const HI_A = new RegExp(`${HI_TARGET}[^।?!\\n]{0,20}(?:बात|संपर्क|कनेक्ट)`);
const HI_B = new RegExp(`(?:बात|संपर्क|कनेक्ट)[^।?!\\n]{0,25}${HI_TARGET}`);

const HG_TARGET = "(?:insaan|insan|aadmi|admi|human|agent|manager|owner|malik|customer care|team|staff|person|vyakti)";
const HG_A = new RegExp(`\\b${HG_TARGET}\\b[^.?!\\n]{0,20}\\b(?:se|ke saath|ko)\\b[^.?!\\n]{0,15}\\b(?:baat|bat|connect|contact|baatchit)\\b`, "i");
const HG_B = new RegExp(`\\b(?:baat|bat)\\b[^.?!\\n]{0,20}\\b${HG_TARGET}\\b`, "i");

export function wantsHuman(text: string): boolean {
  const t = text.normalize("NFC").slice(0, 500);
  return [EN_VERB_TARGET, EN_LIVE, EN_CALL, EN_ALONE, HI_A, HI_B, HG_A, HG_B].some((re) => re.test(t));
}

/** "wa_919876543210" (WhatsApp session id) -> "+919876543210"; anything else -> null. */
export function phoneFromSession(sessionId: string): string | null {
  const m = /^wa_(\d{6,20})$/.exec(sessionId);
  return m ? `+${m[1]}` : null;
}
