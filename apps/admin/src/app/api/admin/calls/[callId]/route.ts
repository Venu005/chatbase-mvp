import { NextResponse } from "next/server";
import { q, q1 } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { HttpError, handle } from "@chatbase/core/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ callId: string }> };

type Retrieved = { chunkId: number; score: number; title: string; url: string | null };
type Fix = { id: string; score: number; question: string };

/** The trace of one answer: question, answer, the passages and Q&A answers it was given (with scores), timings, cost. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  await requireAdmin();
  const id = (await params).callId;
  if (!/^\d{1,18}$/.test(id)) throw new HttpError(404, "Call not found");
  const call = await q1<Record<string, unknown> & { retrieved: Retrieved[]; fixes: Fix[]; message_id: string | null }>(
    `SELECT k.*, k.cost_usd::float AS cost_usd, u.email, a.name AS agent_name
       FROM ai_calls k JOIN users u ON u.id = k.user_id LEFT JOIN agents a ON a.id = k.agent_id WHERE k.id = $1`,
    [id]
  );
  if (!call) throw new HttpError(404, "Call not found");

  const chunkIds = call.retrieved.map((r) => r.chunkId);
  const fixIds = call.fixes.map((f) => f.id);
  const [answer, chunks, fixes] = await Promise.all([
    call.message_id ? q1<{ content: string; feedback: number | null }>("SELECT content, feedback FROM messages WHERE id = $1", [call.message_id]) : null,
    chunkIds.length ? q<{ id: string; content: string }>("SELECT id, content FROM chunks WHERE id = ANY($1::bigint[])", [chunkIds]) : [],
    fixIds.length ? q<{ id: string; question: string; answer: string }>("SELECT id, question, answer FROM answer_fixes WHERE id = ANY($1::uuid[])", [fixIds]) : [],
  ]);
  const text = new Map(chunks.map((c) => [Number(c.id), c.content]));
  const fixText = new Map(fixes.map((f) => [f.id, f]));
  return NextResponse.json({
    call,
    answer: answer?.content ?? null,
    feedback: answer?.feedback ?? null,
    // Passages may have been deleted or re-indexed since; the trace keeps their title and score regardless.
    retrieved: call.retrieved.map((r) => ({ ...r, content: text.get(r.chunkId) ?? null })),
    fixes: call.fixes.map((f) => ({ ...f, answer: fixText.get(f.id)?.answer ?? null })),
  });
});
