/**
 * Answer-quality evaluation. Runs a dataset of questions through the real answer pipeline (retrieval, prompt, model,
 * retries) using the models configured in .env, and scores:
 *   retrieval_hit_rate   the passage that holds the answer was given to the model (hit@k); also hit@1 and MRR
 *   answer_rate          the answer contains an expected fact (price, time...) for questions the sources cover
 *   refusal_rate         for questions the sources don't cover, the assistant says it doesn't know
 *   language_rate        the reply uses the script the customer wrote in (Devanagari for Hindi, Latin otherwise)
 *   grounded_rate        (--judge) a grader model finds no claims unsupported by the passages
 * plus time to first word (p50/p95), tokens and cost per answer.
 *
 * It needs only the database (not a running server): it creates a temporary account and agent, indexes the dataset's
 * sources, asks every question as a fresh visitor (with any earlier turns first), then deletes the account.
 *
 *   pnpm eval                                  run eval/datasets/kirana.json, print the report
 *   pnpm eval -- --dataset eval/datasets/x.json
 *   pnpm eval -- --save-baseline               also save the scores as the baseline for this dataset + models
 *   pnpm eval -- --check                       exit 1 if any rate dropped >5 points below the baseline (for CI)
 *   pnpm eval -- --judge                       grade groundedness with EVAL_JUDGE_PROVIDER / EVAL_JUDGE_MODEL
 *   pnpm eval -- --only sku,hinglish --keep    only some categories; keep the account for inspection
 *
 * Numbers are only meaningful with real models: the mock embeddings match shared words, not meaning.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pool, q, q1 } from "@/lib/db";
import { writeChunks } from "@/lib/ingest";
import { loadAgent, prepareAnswer, saveAnswer, streamAnswer } from "@/lib/answer";
import { newRun } from "@/lib/providers/resilient";
import { embeddingModelId, getLLM, makeLLM } from "@/lib/providers";
import { costUsd, parsePrices } from "@/lib/pricing";
import { containsAny, expectedScript, isRefusal, percentile, rankOf, regressions, script, type Summary } from "@/lib/eval-score";

type Case = {
  id: string;
  category: string;
  lang: "en" | "hi" | "hinglish";
  question: string;
  history?: string[];
  expect: { passage?: string; answer?: string[]; refuse?: boolean; notAnswer?: string[] };
};
type Result = {
  id: string;
  category: string;
  lang: Case["lang"];
  question: string;
  answer: string;
  error: string | null;
  rank: number | null;
  answerOk: boolean | null;
  refusalOk: boolean | null;
  languageOk: boolean;
  grounded: boolean | null;
  firstTokenMs: number | null;
  totalMs: number;
  tokens: number | null;
  cost: number | null;
};
type Dataset = { name: string; instructions?: string; sources: { title: string; text: string }[]; cases: Case[] };

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const datasetPath = opt("--dataset") ?? "eval/datasets/kirana.json";
const only = opt("--only")?.split(",");

const ds = JSON.parse(fs.readFileSync(datasetPath, "utf8")) as Dataset;
const cases = ds.cases.filter((c) => !only || only.includes(c.category) || only.includes(c.id));
const prices = parsePrices(process.env.LLM_PRICES);
const llm = getLLM();
const setup = `${llm.name}:${llm.model} + ${embeddingModelId()}`;

async function main() {
  console.log(`Evaluating "${ds.name}" (${cases.length} questions) with ${setup}\n`);

  // ---- a throw-away account on the Pro plan (so credits never run out) and an agent with the dataset's sources
  const email = `eval-${Date.now()}@eval.invalid`;
  const user = (await q1<{ id: string }>("INSERT INTO users (email, name, password_hash, plan) VALUES ($1, 'Evaluation', '!', 'pro') RETURNING id", [email]))!;
  try {
    const agentRow = (await q1<{ id: string }>(
      "INSERT INTO agents (user_id, name, instructions, handoff_enabled) VALUES ($1, $2, $3, false) RETURNING id",
      [user.id, `Eval: ${ds.name}`.slice(0, 80), ds.instructions ?? ""]
    ))!;
    for (const s of ds.sources) {
      const src = (await q1<{ id: string }>("INSERT INTO sources (agent_id, type, title) VALUES ($1, 'text', $2) RETURNING id", [agentRow.id, s.title]))!;
      const r = await writeChunks(src.id, agentRow.id, [{ title: s.title, url: null, text: s.text }]);
      await q("UPDATE sources SET status = 'ready', char_count = $2, chunk_count = $3 WHERE id = $1", [src.id, r.chars, r.chunks]);
    }
    const agent = (await loadAgent(agentRow.id))!;

    // ---- one turn = exactly what a visitor's message goes through
    async function turn(sessionId: string, message: string) {
      const p = await prepareAnswer(agent, sessionId, "playground", message);
      if ("handedOff" in p) throw new Error("unexpected handoff");
      const run = newRun();
      const t0 = Date.now();
      let text = "";
      let error: string | null = null;
      try {
        for await (const d of streamAnswer(p, run)) text += d;
        await saveAnswer(p, text);
      } catch (e) {
        error = (e as Error).message;
      }
      return { p, run, text, error, ms: Date.now() - t0 };
    }

    const judge = flag("--judge") ? makeLLM(process.env.EVAL_JUDGE_PROVIDER ?? process.env.LLM_PROVIDER ?? "mock", process.env.EVAL_JUDGE_MODEL) : null;
    if (judge?.name === "mock") console.log("(--judge ignored: the grader needs a real model; set EVAL_JUDGE_PROVIDER / EVAL_JUDGE_MODEL)\n");

    const results: Result[] = [];
    for (const c of cases) {
      const session = crypto.randomBytes(12).toString("hex");
      for (const h of c.history ?? []) await turn(session, h);
      const r = await turn(session, c.question);
      const ids = r.p.retrieved.map((x) => x.chunkId);
      const rows = ids.length ? await q<{ id: string; content: string }>("SELECT id, content FROM chunks WHERE id = ANY($1::bigint[])", [ids]) : [];
      const byId = new Map(rows.map((x) => [Number(x.id), x.content]));
      const passages = ids.map((id) => byId.get(id) ?? "");
      const rank = c.expect.passage ? rankOf(passages, c.expect.passage) : null;
      const covered = !c.expect.refuse;
      // A reply that declines never counts as correct, even if it echoes words from the question.
      const answerOk = covered ? !r.error && !isRefusal(r.text) && containsAny(r.text, c.expect.answer) : null;
      const refusalOk = covered ? null : isRefusal(r.text) && !containsAny(r.text, c.expect.notAnswer);
      const languageOk = !r.error && script(r.text) === expectedScript(c.lang);
      let grounded: boolean | null = null;
      if (judge && judge.name !== "mock" && covered && !r.error && !isRefusal(r.text)) grounded = await grade(judge, passages, r.text);
      const usage = r.run.usage;
      results.push({
        id: c.id,
        category: c.category,
        lang: c.lang,
        question: c.question,
        answer: r.text,
        error: r.error,
        rank,
        answerOk,
        refusalOk,
        languageOk,
        grounded,
        firstTokenMs: r.run.firstTokenMs,
        totalMs: r.ms,
        tokens: usage ? usage.inputTokens + usage.outputTokens : null,
        cost: usage ? costUsd(prices, r.run.provider, r.run.model, usage.inputTokens, usage.outputTokens) : null,
      });
      const mark = (v: boolean | null) => (v === null ? " " : v ? "✓" : "✗");
      console.log(
        `  ${mark(rank === null ? null : rank > 0)}${mark(answerOk ?? refusalOk)}${mark(languageOk)} ${c.id.padEnd(18)} ${
          rank === null ? "" : rank ? `passage #${rank}` : "passage missing"
        }${r.error ? `  ERROR ${r.error}` : ""}`
      );
    }

    // ---- summary
    const rate = (xs: (boolean | null)[]) => {
      const v = xs.filter((x): x is boolean => x !== null);
      return v.length ? v.filter(Boolean).length / v.length : null;
    };
    const summarize = (rs: Result[]): Summary => {
      const ranked = rs.filter((r) => r.rank !== null);
      return {
        questions: rs.length,
        retrieval_hit_rate: rate(ranked.map((r) => r.rank! > 0)),
        retrieval_top1_rate: rate(ranked.map((r) => r.rank === 1)),
        retrieval_mrr: ranked.length ? ranked.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / ranked.length : null,
        answer_rate: rate(rs.map((r) => r.answerOk)),
        refusal_rate: rate(rs.map((r) => r.refusalOk)),
        language_rate: rate(rs.map((r) => r.languageOk)),
        grounded_rate: rate(rs.map((r) => r.grounded)),
        success_rate: rate(rs.map((r) => !r.error)),
        first_token_p50_ms: percentile(rs.map((r) => r.firstTokenMs ?? 0), 50),
        first_token_p95_ms: percentile(rs.map((r) => r.firstTokenMs ?? 0), 95),
        avg_tokens: rs.length ? Math.round(rs.reduce((s, r) => s + (r.tokens ?? 0), 0) / rs.length) : null,
        avg_cost_usd: rs.some((r) => r.cost !== null) ? rs.reduce((s, r) => s + (r.cost ?? 0), 0) / rs.length : null,
      };
    };
    const overall = summarize(results);
    const byCategory = Object.fromEntries([...new Set(results.map((r) => r.category))].map((cat) => [cat, summarize(results.filter((r) => r.category === cat))]));

    const pct = (v: number | null | undefined) => (v === null || v === undefined ? "  –  " : `${(v * 100).toFixed(0).padStart(3)}%`);
    console.log(`\n${"category".padEnd(14)} n   hit@k  top1  answer refuse lang  grounded`);
    for (const [cat, s] of [...Object.entries(byCategory), ["ALL", overall] as const]) {
      console.log(
        `${String(cat).padEnd(14)} ${String(s.questions).padEnd(3)} ${pct(s.retrieval_hit_rate)}  ${pct(s.retrieval_top1_rate)} ${pct(s.answer_rate)}  ${pct(s.refusal_rate)}  ${pct(
          s.language_rate
        )} ${pct(s.grounded_rate)}`
      );
    }
    console.log(
      `\nMRR ${overall.retrieval_mrr?.toFixed(2)} · first word p50 ${overall.first_token_p50_ms} ms, p95 ${overall.first_token_p95_ms} ms · ~${overall.avg_tokens} tokens/answer` +
        (overall.avg_cost_usd !== null ? ` · $${(overall.avg_cost_usd as number).toFixed(5)}/answer` : "")
    );

    // ---- save, compare with the baseline for the same dataset + models
    const key = `${path.basename(datasetPath, ".json")}__${setup.replace(/[^\w.-]+/g, "_")}`;
    fs.mkdirSync("eval/results", { recursive: true });
    const report = { dataset: ds.name, setup, at: new Date().toISOString(), overall, byCategory, results };
    fs.writeFileSync(`eval/results/${key}.latest.json`, JSON.stringify(report, null, 2));
    const baselineFile = `eval/baselines/${key}.json`;
    if (flag("--save-baseline")) {
      fs.mkdirSync("eval/baselines", { recursive: true });
      fs.writeFileSync(baselineFile, JSON.stringify({ setup, at: report.at, overall, byCategory }, null, 2) + "\n");
      console.log(`\nSaved baseline ${baselineFile}`);
    } else if (fs.existsSync(baselineFile)) {
      const base = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
      const worse = regressions(overall, base.overall);
      console.log(worse.length ? `\nWorse than the baseline (${base.at.slice(0, 10)}):\n  ${worse.join("\n  ")}` : `\nNo regressions against the baseline (${base.at.slice(0, 10)}).`);
      if (worse.length && flag("--check")) process.exitCode = 1;
    } else console.log(`\nNo baseline yet for ${setup}; save one with --save-baseline.`);
  } finally {
    if (!flag("--keep")) await q("DELETE FROM users WHERE id = $1", [user.id]);
    else console.log(`\nKept the evaluation account ${email}.`);
    await pool.end();
  }
}

/** Asks the grader model whether the answer makes claims the passages don't support. */
async function grade(judge: ReturnType<typeof makeLLM>, passages: string[], answer: string): Promise<boolean | null> {
  const system =
    "You check a customer-support answer against the reference passages it was given. Reply with exactly one word: " +
    "SUPPORTED if every factual claim in the answer (prices, times, places, policies, availability) is stated in the passages, " +
    "otherwise UNSUPPORTED. Greetings, offers to help and 'contact us' suggestions are not factual claims.";
  const content = `<passages>\n${passages.map((p, i) => `[${i + 1}] ${p}`).join("\n\n")}\n</passages>\n\n<answer>\n${answer}\n</answer>`;
  let out = "";
  try {
    for await (const d of judge.stream({ system, messages: [{ role: "user", content }], temperature: 0 })) out += d;
  } catch {
    return null;
  }
  return /\bSUPPORTED\b/i.test(out) && !/UNSUPPORTED/i.test(out);
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
