/**
 * Pure helpers for the admin insights (apps/admin): the language and topic of a visitor's question, an agent's health
 * score and a paying account's churn risk. No imports, so they are unit-tested directly.
 */

// ---- language -----------------------------------------------------------------------------------------------

export type Lang = "en" | "hinglish" | "hi" | "bn" | "ta" | "te" | "kn" | "ml" | "gu" | "pa" | "or" | "ur" | "other";

export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  hinglish: "Hinglish",
  hi: "Hindi / Marathi (Devanagari)",
  bn: "Bengali",
  ta: "Tamil",
  te: "Telugu",
  kn: "Kannada",
  ml: "Malayalam",
  gu: "Gujarati",
  pa: "Punjabi",
  or: "Odia",
  ur: "Urdu",
  other: "Other",
};

const SCRIPTS: [Lang, RegExp][] = [
  ["hi", /\p{Script=Devanagari}/u],
  ["bn", /\p{Script=Bengali}/u],
  ["ta", /\p{Script=Tamil}/u],
  ["te", /\p{Script=Telugu}/u],
  ["kn", /\p{Script=Kannada}/u],
  ["ml", /\p{Script=Malayalam}/u],
  ["gu", /\p{Script=Gujarati}/u],
  ["pa", /\p{Script=Gurmukhi}/u],
  ["or", /\p{Script=Oriya}/u],
  ["ur", /\p{Script=Arabic}/u],
];

// Hindi words typed in English letters. Strong words alone mark a message as Hinglish; weak ones (also short English
// words or names) need a second Hindi word.
const HINGLISH_STRONG = new Set(
  "kya hai hain kitna kitne kitni kaise kaisa kab kahan kaha nahi nahin nhi mujhe chahiye chaiye milega milegi milta milti karna karo kijiye bataiye batao bhaiya bhai accha acha achha theek thik haan hanji aapka aapke aapki mera meri mere hamara hoga hogi raha rahi rahe tha thi abhi jaldi paisa paise daam keemat wapas vapas kyun kyon agar lekin sakta sakte sakti".split(" ")
);
const HINGLISH_WEAK = new Set("ka ki ke ko se me mein par aur ya ji wala wali wale kal aaj aap hum tum koi kuch sab bhi to".split(" "));

/** The language of a message: by script for Indian scripts, else Hinglish (Hindi in English letters) or English. */
export function languageOf(text: string): Lang {
  const letters = (text.match(/\p{L}/gu) ?? []).join("");
  if (!letters) return "other";
  for (const [lang, re] of SCRIPTS) {
    const n = (letters.match(new RegExp(re.source, "gu")) ?? []).length;
    if (n / letters.length >= 0.3) return lang;
  }
  if (!/^[\p{Script=Latin}]+$/u.test(letters)) return "other";
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const strong = words.filter((w) => HINGLISH_STRONG.has(w)).length;
  const weak = new Set(words.filter((w) => HINGLISH_WEAK.has(w))).size;
  return strong >= 2 || (strong === 1 && (weak >= 1 || words.length <= 3)) ? "hinglish" : "en";
}

// ---- topics -------------------------------------------------------------------------------------------------

export type Topic = { id: string; label: string; re: RegExp };

/** What customers ask about, in the order they are tried (the first match wins). English, Hinglish and Hindi. */
export const TOPICS: Topic[] = [
  { id: "order_status", label: "Order status / tracking", re: /\b(track|tracking|order status|where is my order|order id|awb|mera order|order kab)\b|ऑर्डर/ },
  { id: "returns", label: "Returns, refunds, exchanges", re: /\b(return|returns|refund|exchange|replace|replacement|cancel|wapas|vapas)\b|वापस|रिफंड|बदल/ },
  { id: "price", label: "Prices", re: /\b(price|prices|pricing|cost|costs|rate|rates|how much|kitna|kitne|kitni|daam|keemat|mrp|fees?|charges?)\b|₹|\brs\.? ?\d|कीमत|दाम|कितन/ },
  { id: "delivery", label: "Delivery and shipping", re: /\b(deliver|delivery|shipping|ship|courier|dispatch|pincode|pin code|arrive|pahunch)\b|डिलीवरी|पहुँच|पहुंच/ },
  { id: "payment", label: "Payment", re: /\b(pay|payment|upi|cod|cash on delivery|emi|card|gpay|paytm|phonepe|invoice|bill)\b|भुगतान/ },
  { id: "offers", label: "Offers and discounts", re: /\b(discount|offer|offers|coupon|sale|deal|cashback|promo)\b|ऑफर|छूट/ },
  { id: "availability", label: "Stock and availability", re: /\b(stock|available|availability|in stock|milega|milegi|size|sizes|colour|color|variant)\b|उपलब्ध|मिलेगा/ },
  { id: "booking", label: "Bookings and appointments", re: /\b(book|booking|appointment|slot|reservation|reserve|schedule)\b|बुक/ },
  { id: "hours", label: "Opening hours", re: /\b(open|opening|close|closing|timing|timings|hours|sunday|holiday|khula|khulta|band)\b|खुल|बंद/ },
  { id: "location", label: "Address and location", re: /\b(address|location|located|where are you|branch|directions|map|kahan|kaha)\b|पता|कहाँ|कहां/ },
  { id: "contact", label: "Contact / talk to a person", re: /\b(call|phone|number|whatsapp|email|contact|human|agent|person|executive|baat)\b|संपर्क|बात/ },
];

export function topicOf(text: string): string {
  const t = text.toLowerCase();
  return TOPICS.find((x) => x.re.test(t))?.id ?? "other";
}

export const topicLabel = (id: string) => TOPICS.find((t) => t.id === id)?.label ?? "Other";

/** A question normalised for counting repeats: lower case, no punctuation, single spaces. */
export const questionKey = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}₹ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

// ---- agent health -------------------------------------------------------------------------------------------

export type AgentStats = {
  answers: number;
  errors: number;
  gaps: number;
  thumbsUp: number;
  thumbsDown: number;
  readySources: number;
  failedSources: number;
  qaAnswers: number;
};

/**
 * 0–100: how well an agent serves its visitors. Starts at 100 and loses points for failed answers, questions its
 * sources don't cover, unhappy visitors and broken sources. Returns the reasons, worst first.
 */
export function agentHealth(s: AgentStats): { score: number; issues: string[] } {
  const penalties: [number, string][] = [];
  const rate = (a: number, b: number) => (b ? a / b : 0);
  if (s.readySources === 0 && s.qaAnswers === 0) penalties.push([40, "no knowledge added"]);
  const err = rate(s.errors, s.answers);
  if (err > 0.01) penalties.push([Math.min(30, err * 200), `${Math.round(err * 100)}% of answers failed`]);
  const gap = rate(s.gaps, s.answers);
  if (s.answers >= 5 && gap > 0.1) penalties.push([Math.min(30, gap * 60), `${Math.round(gap * 100)}% of questions not in its sources`]);
  const rated = s.thumbsUp + s.thumbsDown;
  const down = rate(s.thumbsDown, rated);
  if (rated >= 3 && down > 0.2) penalties.push([Math.min(20, down * 40), `${Math.round(down * 100)}% of rated answers were 👎`]);
  if (s.failedSources) penalties.push([Math.min(20, s.failedSources * 10), `${s.failedSources} source${s.failedSources === 1 ? "" : "s"} failed to load`]);
  penalties.sort((a, b) => b[0] - a[0]);
  const score = Math.max(0, Math.round(100 - penalties.reduce((t, [p]) => t + p, 0)));
  return { score, issues: penalties.map(([, why]) => why) };
}

// ---- churn risk ---------------------------------------------------------------------------------------------

export type AccountActivity = {
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  answersLast14: number;
  answersPrev14: number;
  daysSinceLastAnswer: number | null;
  gapRate: number;
  thumbsDownRate: number;
};

/** How likely a paying account is to leave, with the reasons (for the admin to act on). */
export function churnRisk(a: AccountActivity): { level: "high" | "medium" | "low"; points: number; reasons: string[] } {
  const r: [number, string][] = [];
  if (a.cancelAtPeriodEnd) r.push([5, "cancels at the end of the period"]);
  if (a.subscriptionStatus === "pending" || a.subscriptionStatus === "halted") r.push([4, "renewal payment is failing"]);
  if (a.daysSinceLastAnswer === null) r.push([3, "never had a real conversation"]);
  else if (a.daysSinceLastAnswer >= 10) r.push([3, `no conversations for ${a.daysSinceLastAnswer} days`]);
  if (a.answersPrev14 >= 20 && a.answersLast14 < a.answersPrev14 * 0.5)
    r.push([2, `usage down ${Math.round((1 - a.answersLast14 / a.answersPrev14) * 100)}% (last 14 days vs the 14 before)`]);
  if (a.gapRate >= 0.4) r.push([1, `${Math.round(a.gapRate * 100)}% of questions go unanswered`]);
  if (a.thumbsDownRate >= 0.3) r.push([1, `${Math.round(a.thumbsDownRate * 100)}% of rated answers were 👎`]);
  r.sort((x, y) => y[0] - x[0]);
  const points = r.reduce((t, [p]) => t + p, 0);
  return { level: points >= 4 ? "high" : points >= 2 ? "medium" : "low", points, reasons: r.map(([, why]) => why) };
}
