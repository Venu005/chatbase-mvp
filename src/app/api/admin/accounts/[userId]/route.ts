import { NextResponse } from "next/server";
import { q, q1 } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { HttpError, handle } from "@/lib/http";
import { SINCE, TZ, periodQuery } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ userId: string }> };

/** One account: its agents with their numbers, its subscription, and its most recent AI calls. */
export const GET = handle<Ctx>(async (req, { params }) => {
  await requireAdmin();
  const userId = (await params).userId;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(404, "Account not found");
  const days = periodQuery.parse(Object.fromEntries(req.nextUrl.searchParams)).days;
  const args = [days, TZ, userId];

  const user = await q1("SELECT id, email, name, plan, created_at FROM users WHERE id = $1", [userId]);
  if (!user) throw new HttpError(404, "Account not found");
  const [subscription, agents, calls] = await Promise.all([
    q1("SELECT plan, status, current_end, cancel_at_period_end FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [userId]),
    q(
      `SELECT a.id, a.name, a.created_at, a.handoff_enabled, a.lead_mode, cardinality(a.allowed_domains) AS allowed_domains,
              (SELECT count(*)::int FROM sources s WHERE s.agent_id = a.id) AS sources,
              (SELECT count(*)::int FROM sources s WHERE s.agent_id = a.id AND s.status = 'failed') AS failed_sources,
              (SELECT COALESCE(sum(chunk_count), 0)::int FROM sources s WHERE s.agent_id = a.id AND s.status = 'ready') AS passages,
              (SELECT count(*)::int FROM answer_fixes f WHERE f.agent_id = a.id) AS qa_answers,
              EXISTS (SELECT 1 FROM whatsapp_channels w WHERE w.agent_id = a.id) AS whatsapp,
              (SELECT count(*)::int FROM leads l WHERE l.agent_id = a.id) AS leads,
              (SELECT count(*)::int FROM conversations c WHERE c.agent_id = a.id AND c.channel <> 'playground' AND c.created_at >= ${SINCE}) AS conversations,
              (SELECT count(*)::int FROM ai_calls k WHERE k.agent_id = a.id AND k.kind = 'answer' AND k.created_at >= ${SINCE}) AS answers,
              (SELECT COALESCE(sum(cost_usd), 0)::float FROM ai_calls k WHERE k.agent_id = a.id AND k.created_at >= ${SINCE}) AS cost_usd,
              (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.agent_id = a.id AND m.knowledge_gap AND m.created_at >= ${SINCE}) AS gaps,
              (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.agent_id = a.id AND m.feedback = -1 AND m.created_at >= ${SINCE}) AS thumbs_down
         FROM agents a WHERE a.user_id = $3 ORDER BY a.created_at`,
      args
    ),
    q(
      `SELECT k.id, k.created_at, k.kind, k.status, k.channel, k.provider, k.model, k.question, k.first_token_ms, k.total_ms,
              k.input_tokens, k.output_tokens, k.cost_usd::float, k.fallback_used, k.attempts, a.name AS agent_name,
              jsonb_array_length(k.retrieved) AS passages, jsonb_array_length(k.fixes) AS fixes
         FROM ai_calls k LEFT JOIN agents a ON a.id = k.agent_id
        WHERE k.user_id = $1 ORDER BY k.created_at DESC LIMIT 50`,
      [userId]
    ),
  ]);
  return NextResponse.json({ user, subscription, agents, calls });
});
