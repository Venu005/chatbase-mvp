import { NextResponse } from "next/server";
import { q } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@chatbase/core/http";
import { SINCE, TZ, periodQuery } from "@/lib/admin";
import { LANG_NAMES, type Lang, agentHealth, languageOf, questionKey, topicLabel, topicOf } from "@chatbase/core/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAMPLE = 20_000;

/**
 * What visitors ask across the whole platform and how well it goes: languages, topics (with how often each goes
 * unanswered), the most repeated questions and knowledge gaps, channels, busy hours (India time), and a health score
 * per agent. Question analysis uses the newest 20,000 real questions of the period.
 */
export const GET = handle(async (req) => {
  await requireAdmin();
  const days = periodQuery.parse(Object.fromEntries(req.nextUrl.searchParams)).days;
  const args = [days, TZ];

  const [questions, channels, hours, agents] = await Promise.all([
    q<{ question: string | null; channel: string; agent_id: string | null; gap: boolean | null; feedback: number | null }>(
      `SELECT k.question, k.channel, k.agent_id, m.knowledge_gap AS gap, m.feedback
         FROM ai_calls k LEFT JOIN messages m ON m.id = k.message_id
        WHERE k.kind = 'answer' AND k.channel <> 'playground' AND k.created_at >= ${SINCE}
        ORDER BY k.created_at DESC LIMIT ${SAMPLE}`,
      args
    ),
    q<{ channel: string; conversations: number; handoffs: number }>(
      `SELECT channel, count(*)::int AS conversations, count(*) FILTER (WHERE handoff_at IS NOT NULL)::int AS handoffs
         FROM conversations WHERE channel <> 'playground' AND created_at >= ${SINCE} GROUP BY 1 ORDER BY 2 DESC`,
      args
    ),
    q<{ dow: number; hour: number; answers: number }>(
      `SELECT extract(isodow FROM created_at AT TIME ZONE $2)::int AS dow, extract(hour FROM created_at AT TIME ZONE $2)::int AS hour, count(*)::int AS answers
         FROM ai_calls WHERE kind = 'answer' AND channel <> 'playground' AND created_at >= ${SINCE} GROUP BY 1, 2`,
      args
    ),
    q<{
      id: string;
      name: string;
      email: string;
      answers: number;
      errors: number;
      gaps: number;
      up: number;
      down: number;
      ready_sources: number;
      failed_sources: number;
      qa_answers: number;
    }>(
      `SELECT a.id, a.name, u.email,
              count(k.*) FILTER (WHERE k.channel <> 'playground')::int AS answers,
              count(k.*) FILTER (WHERE k.channel <> 'playground' AND k.status = 'error')::int AS errors,
              count(m.*) FILTER (WHERE m.knowledge_gap AND k.channel <> 'playground')::int AS gaps,
              count(m.*) FILTER (WHERE m.feedback = 1)::int AS up,
              count(m.*) FILTER (WHERE m.feedback = -1)::int AS down,
              (SELECT count(*)::int FROM sources s WHERE s.agent_id = a.id AND s.status = 'ready') AS ready_sources,
              (SELECT count(*)::int FROM sources s WHERE s.agent_id = a.id AND s.status = 'failed') AS failed_sources,
              (SELECT count(*)::int FROM answer_fixes f WHERE f.agent_id = a.id) AS qa_answers
         FROM agents a JOIN users u ON u.id = a.user_id
         JOIN ai_calls k ON k.agent_id = a.id AND k.kind = 'answer' AND k.created_at >= ${SINCE}
         LEFT JOIN messages m ON m.id = k.message_id
        GROUP BY a.id, u.email`,
      args
    ),
  ]);

  // ---- languages and topics
  type Tally = { questions: number; gaps: number; down: number; rated: number };
  const tally = () => ({ questions: 0, gaps: 0, down: 0, rated: 0 });
  const add = (t: Tally, r: (typeof questions)[number]) => {
    t.questions++;
    if (r.gap) t.gaps++;
    if (r.feedback) t.rated++;
    if (r.feedback === -1) t.down++;
  };
  const langs = new Map<Lang, Tally>();
  const topics = new Map<string, Tally>();
  const repeated = new Map<string, { text: string; count: number; gaps: number; agents: Set<string> }>();
  const channelAnswers = new Map<string, number>();
  for (const r of questions) {
    const text = r.question ?? "";
    const lang = languageOf(text);
    add(langs.get(lang) ?? langs.set(lang, tally()).get(lang)!, r);
    const topic = topicOf(text);
    add(topics.get(topic) ?? topics.set(topic, tally()).get(topic)!, r);
    const key = questionKey(text);
    if (key) {
      const e = repeated.get(key) ?? repeated.set(key, { text: text.slice(0, 200), count: 0, gaps: 0, agents: new Set() }).get(key)!;
      e.count++;
      if (r.gap) e.gaps++;
      if (r.agent_id) e.agents.add(r.agent_id);
    }
    channelAnswers.set(r.channel, (channelAnswers.get(r.channel) ?? 0) + 1);
  }
  const total = questions.length;
  const rates = (t: Tally) => ({
    questions: t.questions,
    share: total ? t.questions / total : 0,
    gap_rate: t.questions ? t.gaps / t.questions : 0,
    down_rate: t.rated ? t.down / t.rated : null,
  });
  const rep = [...repeated.values()].sort((a, b) => b.count - a.count);

  // ---- busy hours: 7 × 24 (Monday first), India time
  const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const h of hours) heat[h.dow - 1][h.hour] = h.answers;

  const health = agents
    .map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      answers: a.answers,
      gap_rate: a.answers ? a.gaps / a.answers : 0,
      ...agentHealth({
        answers: a.answers,
        errors: a.errors,
        gaps: a.gaps,
        thumbsUp: a.up,
        thumbsDown: a.down,
        readySources: a.ready_sources,
        failedSources: a.failed_sources,
        qaAnswers: a.qa_answers,
      }),
    }))
    .sort((a, b) => a.score - b.score || b.answers - a.answers)
    .slice(0, 100);

  return NextResponse.json({
    days: Number(days),
    questions: total,
    sampled: total === SAMPLE,
    languages: [...langs.entries()].map(([lang, t]) => ({ lang, name: LANG_NAMES[lang], ...rates(t) })).sort((a, b) => b.questions - a.questions),
    topics: [...topics.entries()].map(([id, t]) => ({ id, label: topicLabel(id), ...rates(t) })).sort((a, b) => b.questions - a.questions),
    topQuestions: rep.slice(0, 30).map((e) => ({ question: e.text, count: e.count, gaps: e.gaps, agents: e.agents.size })),
    topGaps: rep
      .filter((e) => e.gaps > 0)
      .sort((a, b) => b.gaps - a.gaps)
      .slice(0, 30)
      .map((e) => ({ question: e.text, count: e.count, gaps: e.gaps, agents: e.agents.size })),
    channels: channels.map((c) => ({ ...c, answers: channelAnswers.get(c.channel) ?? 0 })),
    busyHours: heat,
    agents: health,
  });
});
