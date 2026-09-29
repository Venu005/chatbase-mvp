// Fast unit tests for the pure logic (no server or database needed):  pnpm test
// Imports the TypeScript sources directly using Node's built-in type stripping (Node 22.18+ / 23.6+).
import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/lib/chunk.ts";
import { formatForWhatsApp } from "../src/lib/wa-format.ts";
import { decryptSecret, encryptSecret, safeEqual } from "../src/lib/crypto.ts";
import { phoneFromSession, wantsHuman } from "../src/lib/handoff-intent.ts";
import { createThinkFilter } from "../src/lib/providers/think.ts";
import { normalizeTurns, trimHistory } from "../src/lib/providers/turns.ts";
import { newRun, resilientStream, withRetries } from "../src/lib/providers/resilient.ts";
import { ProviderError } from "../src/lib/providers/types.ts";
import { costUsd, embeddingCostUsd, parsePrices } from "../src/lib/pricing.ts";
import { containsAny, isRefusal, normalize, percentile, rankOf, regressions, script } from "../src/lib/eval-score.ts";
import { dropNearDuplicates, fuse, keywordCoverage, keywordQuery, keywordTerms } from "../src/lib/keywords.ts";
import { rerank } from "../src/lib/rerank.ts";
import { questionKey } from "../src/lib/cache-key.ts";
import { isSmallTalk, route } from "../src/lib/routing.ts";
import http from "node:http";
import { parseInline, parseMarkdown } from "../src/lib/markdown.ts";
import { embedAllowed, hostAllowed, normalizeDomain } from "../src/lib/domains.ts";
import { csvCell, normalizeEmail, normalizePhone, parseContact, toCsv } from "../src/lib/leads.ts";

process.env.AUTH_SECRET ??= "unit-test-secret-unit-test-secret-1234";

test("chunkText: every chunk fits the size limit (plus overlap) and no text is lost", () => {
  const sentence = "Our shop delivers across the city and we accept UPI cards and cash. ";
  const text = sentence.repeat(200);
  const chunks = chunkText(text, 900, 120);
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.length <= 900 + 120, `chunk too long: ${c.length}`);
  const all = chunks.join(" ");
  for (const w of ["delivers", "UPI", "cash"]) assert.ok(all.includes(w));
});

test("chunkText: splits Hindi text on the danda (।) instead of cutting mid-sentence", () => {
  const s = "आप डिलीवरी के सात दिनों के भीतर कोई भी सामान वापस कर सकते हैं।";
  const chunks = chunkText((s + " ").repeat(60), 300, 0);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.endsWith("।"), `chunk should end at a sentence boundary: …${c.slice(-15)}`);
});

test("chunkText: empty and tiny inputs", () => {
  assert.deepEqual(chunkText("   \n\n  "), []);
  assert.deepEqual(chunkText("Short but valid text here."), ["Short but valid text here."]);
});

test("chunkText: a single huge word is hard-split rather than looping forever", () => {
  const chunks = chunkText("x".repeat(5000), 900, 0);
  assert.ok(chunks.length >= 5 && chunks.every((c) => c.length <= 900));
});

test("formatForWhatsApp: strips [n] markers, converts bold, appends source links", () => {
  const out = formatForWhatsApp("## Hours\nWe are open **8am to 10pm** [1]. Delivery is free [2].", [
    { n: 1, title: "FAQ", url: "https://shop.in/faq" },
    { n: 2, title: "Shipping", url: "https://shop.in/shipping" },
    { n: 3, title: "Third", url: "https://shop.in/third" },
  ]);
  assert.equal(out.length, 1);
  assert.ok(!/\[\d\]/.test(out[0]) && !out[0].includes("##") && !out[0].includes("**"));
  assert.ok(out[0].includes("*8am to 10pm*"));
  assert.ok(out[0].includes("https://shop.in/faq") && out[0].includes("https://shop.in/shipping") && !out[0].includes("third"));
});

test("formatForWhatsApp: long answers are split under WhatsApp's 4096-character limit without losing text", () => {
  const para = "This is a paragraph of the answer with several words in it. ".repeat(20).trim();
  const long = Array.from({ length: 15 }, (_, i) => `Part ${i}: ${para}`).join("\n\n");
  const parts = formatForWhatsApp(long, []);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 4000, `part too long: ${p.length}`);
  for (let i = 0; i < 15; i++) assert.ok(parts.join("\n").includes(`Part ${i}:`));
});

test("crypto: encrypt/decrypt round-trips, is randomised, and detects tampering", () => {
  const secret = "EAAG-super-secret-access-token";
  const a = encryptSecret(secret);
  const b = encryptSecret(secret);
  assert.notEqual(a, b);
  assert.ok(!a.includes(secret));
  assert.equal(decryptSecret(a), secret);
  const parts = a.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(parts.join(":")));
  assert.throws(() => decryptSecret("garbage"));
});

test("crypto: safeEqual", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
});

test("wantsHuman: recognises requests for a person in English, Hindi and Hinglish", () => {
  for (const t of [
    "I want to talk to a human",
    "Can I speak to someone from your team?",
    "please connect me to an agent",
    "agent",
    "Human",
    "talk to the owner",
    "call me please",
    "I need a real person",
    "मुझे किसी इंसान से बात करनी है",
    "मैनेजर से बात कराइए",
    "कस्टमर केयर से संपर्क करना है",
    "kisi insaan se baat karni hai",
    "manager se baat karao",
    "baat karni hai owner se",
  ]) assert.ok(wantsHuman(t), `should hand off: ${t}`);
});

test("wantsHuman: ordinary questions are not handoffs", () => {
  for (const t of [
    "Do you sell human hair wigs?",
    "What is your return policy?",
    "Is the agent commission included in the price?",
    "I spoke to your team yesterday and they said 5 days",
    "कीमत क्या है?",
    "delivery kitne din mein hoti hai",
    "Do you have live chat support hours?",
    "",
  ]) assert.ok(!wantsHuman(t), `should NOT hand off: ${t}`);
});

test("phoneFromSession: only WhatsApp session ids map to a phone number", () => {
  assert.equal(phoneFromSession("wa_919876543210"), "+919876543210");
  assert.equal(phoneFromSession("abcdef0123456789"), null);
  assert.equal(phoneFromSession("wa_notdigits"), null);
});

function runThink(chunks) {
  const f = createThinkFilter();
  return chunks.map((c) => f.push(c)).join("") + f.flush();
}

test("think filter: hides <think> blocks, even when tags are split across chunks", () => {
  assert.equal(runThink(["Hello ", "world"]), "Hello world");
  assert.equal(runThink(["<think>plan the answer</think>\n\nThe shop opens at 8am."]), "The shop opens at 8am.");
  assert.equal(runThink(["<thi", "nk>secret ", "reasoning</th", "ink>\nOpen till 10pm ", "daily."]), "Open till 10pm daily.");
  assert.equal(runThink(["Yes. <think>hmm</think>Delivery is free."]), "Yes. Delivery is free.");
  assert.equal(runThink(["a < b and 3 <5"]), "a < b and 3 <5"); // a lone "<" is not a tag
  assert.equal(runThink(["Answer <thi"]), "Answer <thi"); // an incomplete tag at the very end is flushed as text
  assert.equal(runThink(["<think>never closed"]), ""); // an unfinished thought is never shown
  assert.equal(runThink(["दुकान सुबह ८ बजे खुलती है। <think>x</think>धन्यवाद"]), "दुकान सुबह ८ बजे खुलती है। धन्यवाद");
});

test("normalizeTurns: merges same-role turns and never starts with the assistant", () => {
  const out = normalizeTurns([
    { role: "assistant", content: "Welcome" },
    { role: "user", content: "hi" },
    { role: "user", content: "anyone there?" },
    { role: "assistant", content: "A team member will reply" },
    { role: "assistant", content: "Hi, Ramesh here" },
    { role: "user", content: "  " },
    { role: "user", content: "thanks, and the price?" },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "hi\n\nanyone there?" },
    { role: "assistant", content: "A team member will reply\n\nHi, Ramesh here" },
    { role: "user", content: "thanks, and the price?" },
  ]);
});

test("parseMarkdown: paragraphs, headings, lists and code blocks", () => {
  const blocks = parseMarkdown("## Refunds\nYou can return items.\nWithin 7 days.\n\n- UPI\n- Cards\n\n1. Pack it\n2. Ship it\n\n```\nraw *text*\n```");
  assert.deepEqual(blocks.map((b) => b.t), ["h", "p", "ul", "ol", "pre"]);
  assert.equal(blocks[1].lines.length, 2);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[3].start, 1);
  assert.equal(blocks[4].v, "raw *text*");
});

test("parseInline: bold, italic, code, links; citations and unclosed syntax stay text", () => {
  assert.deepEqual(parseInline("**Free** delivery [1]"), [{ t: "b", c: [{ t: "text", v: "Free" }] }, { t: "text", v: " delivery [1]" }]);
  assert.deepEqual(parseInline("*note*"), [{ t: "i", c: [{ t: "text", v: "note" }] }]);
  assert.deepEqual(parseInline("use `a*b*c`"), [{ t: "text", v: "use " }, { t: "code", v: "a*b*c" }]);
  assert.deepEqual(parseInline("[Shop](https://x.in/s)"), [{ t: "a", href: "https://x.in/s", c: [{ t: "text", v: "Shop" }] }]);
  assert.deepEqual(parseInline("see https://x.in/faq."), [{ t: "text", v: "see " }, { t: "a", href: "https://x.in/faq", c: [{ t: "text", v: "https://x.in/faq" }] }, { t: "text", v: "." }]);
  assert.deepEqual(parseInline("**still stream"), [{ t: "text", v: "**still stream" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ t: "text", v: "2 * 3 * 4" }]);
});

test("parseInline: only http(s) links become links", () => {
  assert.ok(parseInline("[x](javascript:alert(1))").every((n) => n.t === "text"));
});

test("normalizeDomain: accepts hosts and URLs, rejects junk", () => {
  assert.equal(normalizeDomain("https://www.Example.com/contact"), "www.example.com");
  assert.equal(normalizeDomain(" shop.example.co.in "), "shop.example.co.in");
  assert.equal(normalizeDomain("localhost"), "localhost");
  for (const bad of ["", "not a domain", "example", "http://", "exa_mple.com"]) assert.equal(normalizeDomain(bad), null, bad);
});

test("hostAllowed: exact host and subdomains only; empty list allows all", () => {
  assert.ok(hostAllowed("anything.com", []));
  assert.ok(hostAllowed("example.com", ["example.com"]));
  assert.ok(hostAllowed("www.example.com", ["example.com"]));
  assert.ok(!hostAllowed("badexample.com", ["example.com"]));
  assert.ok(!hostAllowed("example.com.evil.io", ["example.com"]));
});

test("embedAllowed: framed pages must come from an allowed site", () => {
  const base = { allowed: ["shop.in"], selfHost: "app.test" };
  assert.ok(embedAllowed({ ...base, allowed: [], dest: "iframe", referer: "https://evil.io/" }));
  assert.ok(embedAllowed({ ...base, dest: "iframe", referer: "https://www.shop.in/" }));
  assert.ok(!embedAllowed({ ...base, dest: "iframe", referer: "https://evil.io/" }));
  assert.ok(!embedAllowed({ ...base, dest: "iframe", referer: null }), "referer stripped");
  assert.ok(embedAllowed({ ...base, dest: "document", referer: "https://evil.io/" }), "full-page link");
  assert.ok(embedAllowed({ ...base, dest: "iframe", referer: "https://app.test/dashboard" }), "own app");
  assert.ok(!embedAllowed({ ...base, dest: null, referer: "https://evil.io/" }), "old browser with referer");
  assert.ok(embedAllowed({ ...base, dest: null, referer: null }), "old browser, nothing to judge by");
});

test("normalizePhone / normalizeEmail / parseContact", () => {
  assert.equal(normalizePhone("+91 98765-43210"), "+919876543210");
  assert.equal(normalizePhone("(080) 4567 8900"), "08045678900");
  for (const bad of ["12345", "call me", "+91 98765 43210 ext 5", "1".repeat(16)]) assert.equal(normalizePhone(bad), null, bad);
  assert.equal(normalizeEmail(" Ravi@Example.IN "), "ravi@example.in");
  assert.equal(normalizeEmail("ravi@localhost"), null);
  assert.deepEqual(parseContact("ravi@example.in"), { email: "ravi@example.in" });
  assert.deepEqual(parseContact("98765 43210"), { phone: "9876543210" });
  assert.equal(parseContact("tomorrow evening"), null);
});

test("toCsv: quoting, Unicode, and spreadsheet-formula (CSV injection) defusing", () => {
  assert.equal(toCsv(["a", "b"], [["x,y", 'say "hi"']]), 'a,b\r\n"x,y","say ""hi"""\r\n');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("-cmd"), "'-cmd");
  assert.equal(csvCell("+919876543210"), "+919876543210");
  assert.equal(csvCell("रवि"), "रवि");
  assert.equal(csvCell(null), "");
});

test("trimHistory keeps the newest turns within the budget and caps long turns", () => {
  const h = [
    { role: "user", content: "a".repeat(3000) },
    { role: "assistant", content: "b".repeat(1000) },
    { role: "user", content: "c".repeat(1000) },
  ];
  const t = trimHistory(h, 2600);
  assert.deepEqual(t.map((m) => m.content[0]), ["b", "c"], "the oldest turn that doesn't fit is dropped; order is kept");
  assert.equal(trimHistory(h, 10_000)[0].content.length, 1501, "long turns are capped at 1,500 characters (+ …)");
  assert.deepEqual(trimHistory(h, 0), []);
});

// ---- resilient model calls --------------------------------------------------------------------------
/** A fake chat model: `script` lists, per call, either an error to throw before the first token or the words to send. */
function fakeLLM(name, script, opts = {}) {
  let call = 0;
  return {
    name,
    model: `${name}-model`,
    calls: () => call,
    async *stream({ signal, onUsage }) {
      const step = script[Math.min(call++, script.length - 1)];
      if (step === "hang") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      if (step instanceof Error) throw step;
      for (const [i, w] of step.entries()) {
        if (opts.breakAfter !== undefined && i === opts.breakAfter) throw new ProviderError("broke", 502);
        yield w;
      }
      onUsage?.({ inputTokens: 10, outputTokens: step.length });
    },
  };
}
const collect = async (gen) => {
  let out = "";
  for await (const d of gen) out += d;
  return out;
};
process.env.LLM_RETRIES = "2";

test("resilientStream: retries rate limits with backoff, then answers", async () => {
  const llm = fakeLLM("p", [new ProviderError("429", 429), new ProviderError("503", 503), ["ok", "!"]]);
  const run = newRun();
  assert.equal(await collect(resilientStream({ system: "", messages: [] }, llm, null, run)), "ok!");
  assert.equal(run.attempts, 3);
  assert.equal(run.errors.length, 2);
  assert.deepEqual(run.usage, { inputTokens: 10, outputTokens: 2 });
  assert.equal(run.fallbackUsed, false);
  assert.ok(run.firstTokenMs >= 0);
});

test("resilientStream: a bad key isn't retried but goes straight to the backup model", async () => {
  const llm = fakeLLM("p", [new ProviderError("401", 401)]);
  const backup = fakeLLM("b", [["from backup"]]);
  const run = newRun();
  assert.equal(await collect(resilientStream({ system: "", messages: [] }, llm, backup, run)), "from backup");
  assert.equal(llm.calls(), 1);
  assert.equal(run.fallbackUsed, true);
  assert.equal(run.provider, "b");
});

test("resilientStream: gives up after retries when there is no backup", async () => {
  const llm = fakeLLM("p", [new ProviderError("500", 500)]);
  await assert.rejects(collect(resilientStream({ system: "", messages: [] }, llm, null, newRun())), /500/);
  assert.equal(llm.calls(), 3);
});

test("resilientStream: never retries once text has reached the customer", async () => {
  const llm = fakeLLM("p", [["one ", "two ", "three"]], { breakAfter: 2 });
  let got = "";
  await assert.rejects(async () => {
    for await (const d of resilientStream({ system: "", messages: [] }, llm, fakeLLM("b", [["x"]]), newRun())) got += d;
  }, /broke/);
  assert.equal(got, "one two ");
  assert.equal(llm.calls(), 1);
});

test("resilientStream: a model that never starts answering times out and is retried", async () => {
  process.env.LLM_FIRST_TOKEN_TIMEOUT_MS = "50";
  const llm = fakeLLM("p", ["hang", ["late but fine"]]);
  const run = newRun();
  assert.equal(await collect(resilientStream({ system: "", messages: [] }, llm, null, run)), "late but fine");
  assert.match(run.errors[0], /timed out/);
  delete process.env.LLM_FIRST_TOKEN_TIMEOUT_MS;
});

test("withRetries: retries retryable errors only", async () => {
  let n = 0;
  assert.equal(await withRetries(async () => (++n < 3 ? Promise.reject(new ProviderError("429", 429)) : "done"), { baseMs: 1 }), "done");
  let m = 0;
  await assert.rejects(withRetries(async () => (m++, Promise.reject(new ProviderError("400", 400))), { baseMs: 1 }), /400/);
  assert.equal(m, 1);
});

test("pricing: LLM_PRICES parsing and cost per call", () => {
  const prices = parsePrices("gpt-4.1-mini=0.40/1.60, Claude-Haiku-4-5 = 1/5, junk, x=1");
  assert.equal(prices.size, 2);
  assert.equal(costUsd(prices, "openai-compatible", "gpt-4.1-mini", 1_000_000, 500_000), 1.2);
  assert.equal(costUsd(prices, "anthropic", "claude-haiku-4-5", 2000, 300), 0.0035);
  assert.equal(costUsd(prices, "anthropic", "unknown-model", 1000, 1000), null, "no price configured");
  assert.equal(costUsd(prices, "mock", "mock", 1000, 1000), 0);
  assert.equal(embeddingCostUsd(0.02, "openai-compatible", 1_000_000), 0.02);
  assert.equal(embeddingCostUsd(undefined, "openai-compatible", 10), null);
});

test("eval scoring: normalising, refusals, scripts, ranks, regressions", () => {
  assert.equal(normalize("  Up to ₹2,000  per  Order "), "up to ₹2000 per order");
  assert.ok(containsAny("COD is available up to ₹2000", ["2,000"]));
  assert.ok(!containsAny("We open at 7am", ["10pm"]));
  for (const t of ["I don't have information about that.", "Sorry, please contact the store.", "मुझे इसकी जानकारी नहीं है", "iske baare mein nahi pata"]) assert.ok(isRefusal(t), t);
  assert.ok(!isRefusal("Yes, we deliver to Domlur in 2 hours."));
  assert.equal(script("हम दो घंटे में डिलीवरी करते हैं (2 hours)"), "devanagari");
  assert.equal(script("haan, COD milta hai"), "latin");
  assert.equal(rankOf(["a", "Price AA-5K ₹265", "x"], "aa-5k"), 2);
  assert.equal(rankOf(["a"], "zzz"), 0);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.deepEqual(regressions({ answer_rate: 0.7, retrieval_hit_rate: 0.9, avg_tokens: 900 }, { answer_rate: 0.8, retrieval_hit_rate: 0.92, avg_tokens: 100 }), ["answer_rate: 80.0% → 70.0%"]);
});

test("keywords: terms, Hinglish equivalents, product codes and Hindi; tsquery building", () => {
  assert.deepEqual(keywordTerms("How much is AM-B500?"), ["am-b500"]);
  assert.deepEqual(keywordTerms("atta ka rate kya hai?"), ["atta", "rate", "price"]);
  assert.deepEqual(keywordTerms("डिलीवरी में कितना समय लगता है?"), ["डिलीवरी", "समय", "लगता"]);
  assert.equal(keywordQuery("What is the?"), null, "only filler words: no keyword search");
  assert.equal(keywordQuery("sunday AA-5K it's"), "'sunday':* | 'aa-5k'", "filler and one-letter words are dropped");
});

test("keywordCoverage: keyword-only matches need a real share of the question's words", () => {
  const prices = "Aashirvaad Whole Wheat Atta 5 kg (code AA-5K): ₹265. Price list";
  assert.equal(keywordCoverage("atta ka rate kya hai", prices), 1);
  assert.equal(keywordCoverage("price of aa-5k?", prices), 1);
  assert.ok(keywordCoverage("recommend a good pizza place nearby", "Orders placed after 8pm are delivered the next morning.") < 0.5);
  assert.equal(keywordCoverage("sunday timings", "Open every day, including Sundays"), 0.5, "prefix match: sunday ~ Sundays");
});

test("fuse (reciprocal rank fusion): agreement between lists wins", () => {
  const r = fuse([["a", "b", "c"], ["c", "d"]], (x) => x);
  assert.equal(r[0].item, "c", "c is in both lists");
  assert.deepEqual(r[0].in, [0, 1]);
  assert.deepEqual(r.map((x) => x.item).sort(), ["a", "b", "c", "d"]);
});

test("dropNearDuplicates keeps the best-ranked copy of repeated boilerplate", () => {
  const footer = "Sharma Kirana, 12 CMH Road, Indiranagar. Call +91 98450 12345. Open 7am to 10pm.";
  const r = dropNearDuplicates([{ id: 1, content: footer }, { id: 2, content: "Atta 5 kg costs ₹265." }, { id: 3, content: footer + " " }, { id: 4, content: footer.replace("7am", "8am") }]);
  assert.deepEqual(r.map((x) => x.id), [1, 2]);
});

test("rerank: Cohere/Jina-style API reorders candidates; failures keep the original order", async () => {
  let body = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      body = JSON.parse(raw);
      if (body.query === "fail") return (res.statusCode = 500), res.end("boom");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { RERANK_API_KEY: "k", RERANK_MODEL: "rerank-test", RERANK_BASE_URL: `http://127.0.0.1:${server.address().port}` });
  try {
    assert.deepEqual(await rerank("atta price", ["a", "b", "c"], 2), [2, 0]);
    assert.equal(body.model, "rerank-test");
    assert.equal(body.top_n, 2);
    assert.equal(await rerank("fail", ["a", "b"], 2), null, "server error: keep the fused order");
    delete process.env.RERANK_API_KEY;
    assert.equal(await rerank("x", ["a", "b"], 2), null, "not configured");
  } finally {
    server.close();
  }
});

test("questionKey: same question in any casing/punctuation, but words, numbers and script matter", () => {
  assert.equal(questionKey("What are your timings?"), questionKey("  what are your TIMINGS "));
  assert.equal(questionKey("COD milta hai kya??"), "cod milta hai kya");
  assert.notEqual(questionKey("Price of AA-5K"), questionKey("Price of AA-10K"));
  assert.equal(questionKey("डिलीवरी कब होगी?"), "डिलीवरी कब होगी");
  assert.notEqual(questionKey("delivery kab hogi"), questionKey("डिलीवरी कब होगी"));
  assert.equal(questionKey("???"), null);
  assert.equal(questionKey("x".repeat(201)), null, "long questions aren't cached");
});

test("routing: small talk (English, Hinglish, Hindi) and close Q&A matches go to the small model", () => {
  for (const t of ["hi", "Hello!", "thanks a lot 🙏", "Thank you so much", "ok", "okk", "dhanyavaad ji", "shukriya", "धन्यवाद", "bye", "good morning sir"]) assert.ok(isSmallTalk(t), t);
  for (const t of ["hi, what are your timings?", "thanks, and the 10 kg one?", "hello? anyone there?", "ok so do you deliver to Domlur", "is the shop open"]) assert.ok(!isSmallTalk(t), t);
  assert.equal(route("thanks!", null), "small");
  assert.equal(route("Do you deliver on Sunday?", 0.93), "small");
  assert.equal(route("Do you deliver on Sunday?", 0.6), "main");
  assert.equal(route("What is the refund policy?", null), "main");
});
