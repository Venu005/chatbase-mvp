import { NextResponse } from "next/server";
import { q, toVector } from "@chatbase/core/db";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@chatbase/core/http";
import { embeddingModelId, getEmbedder } from "@chatbase/core/providers";
import { requeueSource } from "@chatbase/core/ingest-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * After changing the embedding model: queues every source whose passages were made with another model (websites are
 * read again; files and text from their kept content) and re-embeds Q&A answers. Sources whose content wasn't kept
 * are reported so their owners can re-add them.
 */
export const POST = handle(async () => {
  await requireAdmin();
  const model = embeddingModelId();
  const stale = await q<{ id: string; type: string; reprocessable: boolean }>(
    `SELECT s.id, s.type, (s.type = 'url' OR EXISTS (SELECT 1 FROM source_payloads p WHERE p.source_id = s.id AND (p.docs IS NOT NULL OR p.file IS NOT NULL))) AS reprocessable
       FROM sources s
      WHERE s.status <> 'processing' AND EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = s.id AND c.embedding_model IS NOT NULL AND c.embedding_model <> $1)`,
    [model]
  );
  let queued = 0;
  for (const s of stale) if (s.reprocessable && (await requeueSource(s.id))) queued++;

  const fixes = await q<{ id: string; question: string }>("SELECT id, question FROM answer_fixes WHERE embedding_model IS NOT NULL AND embedding_model <> $1", [model]);
  const embedder = getEmbedder();
  for (let i = 0; i < fixes.length; i += 64) {
    const batch = fixes.slice(i, i + 64);
    const vectors = await embedder.embed(batch.map((f) => f.question));
    for (const [j, f] of batch.entries()) await q("UPDATE answer_fixes SET embedding = $2::vector, embedding_model = $3 WHERE id = $1", [f.id, toVector(vectors[j]), model]);
  }
  return NextResponse.json({ model, sourcesQueued: queued, sourcesNotReprocessable: stale.filter((s) => !s.reprocessable).length, qaAnswersReembedded: fixes.length });
});
