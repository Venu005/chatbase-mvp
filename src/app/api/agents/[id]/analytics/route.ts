import { NextResponse } from "next/server";
import { z } from "zod";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const query = z.object({ days: z.enum(["7", "30", "90"]).optional().default("30") });

// Days are counted in Indian time; the owner's own playground tests are left out of every number.
const TZ = "Asia/Kolkata";

/** Everything the Analytics tab shows for one agent over the last N days. */
export const GET = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const days = Number(query.parse(Object.fromEntries(req.nextUrl.searchParams)).days);
  const args = [agent.id, String(days), TZ];
  const since = `(date_trunc('day', now() AT TIME ZONE $3) - (($2::int - 1) || ' days')::interval) AT TIME ZONE $3`;

  const [totals, perDay, channels, gaps, disliked] = await Promise.all([
    q1<Record<string, number>>(
      `SELECT
         (SELECT count(*)::int FROM conversations c WHERE c.agent_id = $1 AND c.channel <> 'playground' AND c.created_at >= ${since}) AS conversations,
         (SELECT count(*)::int FROM conversations c WHERE c.agent_id = $1 AND c.channel <> 'playground' AND c.handoff_at >= ${since}) AS handoffs,
         count(*) FILTER (WHERE m.role = 'user')::int AS visitor_messages,
         count(*) FILTER (WHERE m.role = 'assistant' AND m.latency_ms IS NOT NULL)::int AS answers,
         count(*) FILTER (WHERE m.knowledge_gap)::int AS gaps,
         count(*) FILTER (WHERE m.feedback = 1)::int AS thumbs_up,
         count(*) FILTER (WHERE m.feedback = -1)::int AS thumbs_down,
         count(*) FILTER (WHERE m.role = 'human')::int AS team_replies,
         COALESCE(round(avg(m.latency_ms) FILTER (WHERE m.latency_ms IS NOT NULL))::int, 0) AS avg_latency_ms
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.agent_id = $1 AND c.channel <> 'playground' AND m.created_at >= ${since}`,
      args
    ),
    q<{ day: string; conversations: number }>(
      `SELECT to_char(c.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, count(*)::int AS conversations
         FROM conversations c WHERE c.agent_id = $1 AND c.channel <> 'playground' AND c.created_at >= ${since}
        GROUP BY 1 ORDER BY 1`,
      args
    ),
    q<{ channel: string; conversations: number }>(
      `SELECT c.channel, count(*)::int AS conversations FROM conversations c
        WHERE c.agent_id = $1 AND c.channel <> 'playground' AND c.created_at >= ${since} GROUP BY 1 ORDER BY 2 DESC`,
      args
    ),
    // Questions nothing in the sources answered, most asked first.
    q<{ question: string; times: number; last_asked: string }>(
      `SELECT min(u.content) AS question, count(*)::int AS times, max(m.created_at) AS last_asked
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         CROSS JOIN LATERAL (SELECT content FROM messages u WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND u.id < m.id ORDER BY u.id DESC LIMIT 1) u
        WHERE c.agent_id = $1 AND c.channel <> 'playground' AND m.knowledge_gap AND m.created_at >= ${since}
        GROUP BY lower(btrim(u.content)) ORDER BY 2 DESC, 3 DESC LIMIT 20`,
      args
    ),
    // Answers visitors marked 👎, grouped by question (the latest answer is shown), most disliked first.
    q<{ message_id: string; question: string | null; answer: string; times: number; last_at: string; fixed: boolean }>(
      `SELECT DISTINCT ON (g.key) g.message_id, g.question, g.answer, g.times, g.last_at, g.fixed FROM (
         SELECT m.id AS message_id, u.content AS question, m.content AS answer,
                lower(btrim(coalesce(u.content, ''))) AS key,
                count(*) OVER w AS times, max(m.created_at) OVER w AS last_at,
                bool_or(EXISTS (SELECT 1 FROM answer_fixes f WHERE f.message_id = m.id)) OVER w AS fixed
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           LEFT JOIN LATERAL (SELECT content FROM messages u WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND u.id < m.id ORDER BY u.id DESC LIMIT 1) u ON true
          WHERE c.agent_id = $1 AND m.feedback = -1 AND m.created_at >= ${since}
         WINDOW w AS (PARTITION BY lower(btrim(coalesce(u.content, ''))))
       ) g ORDER BY g.key, g.message_id DESC`,
      args
    ),
  ]);

  // One entry per day (zero-filled), oldest first.
  const counts = new Map(perDay.map((d) => [d.day, d.conversations]));
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1 - i));
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { day, conversations: counts.get(day) ?? 0 };
  });

  const dislikedTop = disliked
    .map((d) => ({ ...d, times: Number(d.times) }))
    .sort((x, y) => y.times - x.times || y.last_at.localeCompare(x.last_at))
    .slice(0, 20);
  return NextResponse.json({ days, totals, series, channels, gaps, disliked: dislikedTop });
});
