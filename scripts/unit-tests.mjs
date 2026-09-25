// Fast unit tests for the pure logic (no server or database needed):  pnpm test
// Imports the TypeScript sources directly using Node's built-in type stripping (Node 22.18+ / 23.6+).
import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/lib/chunk.ts";
import { formatForWhatsApp } from "../src/lib/wa-format.ts";
import { decryptSecret, encryptSecret, safeEqual } from "../src/lib/crypto.ts";
import { phoneFromSession, wantsHuman } from "../src/lib/handoff-intent.ts";
import { createThinkFilter } from "../src/lib/providers/think.ts";
import { normalizeTurns } from "../src/lib/providers/turns.ts";
import { parseInline, parseMarkdown } from "../src/lib/markdown.ts";
import { embedAllowed, hostAllowed, normalizeDomain } from "../src/lib/domains.ts";

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
