import { q, q1 } from "./db";
import { envNum, env } from "./env";
import { PermanentIngestError, fetchDocs, looksScanned, pdfText, writeChunks, type Doc } from "./ingest";
import { csvToBlocks, textToBlocks, type Block } from "./structure";
import { OCR_IMAGE_TYPES, ocr, ocrConfigured } from "./ocr";
import { recordOcr } from "./ai-log";
import { normalizeText } from "./chunk";
import { ProviderError } from "./providers/types";

/**
 * Durable ingestion queue in Postgres (no extra infrastructure). A source with status 'processing' is a job:
 *  - workers claim due jobs with FOR UPDATE SKIP LOCKED and a lease (locked_until), so several app servers can run
 *    workers side by side, and a job whose server died is picked up again when its lease runs out
 *  - transient failures (rate limits, timeouts, provider or website 5xx) are retried with backoff, up to
 *    INGEST_MAX_ATTEMPTS (default 3); permanent ones (404, empty file, blocked address) fail at once
 * Workers start with the server (src/instrumentation.ts). INGEST_WORKER=off stops them on this server.
 */

const LEASE_MINUTES = 15; // longer than the slowest job: 20 pages x 15 s + embedding
const maxAttempts = () => Math.max(1, envNum("INGEST_MAX_ATTEMPTS", 3));
const retryBaseMs = () => envNum("INGEST_RETRY_BASE_MS", 30_000);

export type Payload = { docs?: Doc[]; file?: Uint8Array; fileExt?: string };

/** Stores what a new source is made of and wakes a worker. The source row must already exist (status 'processing'). */
export async function enqueueSource(sourceId: string, payload: Payload | null): Promise<void> {
  if (payload) {
    await q("INSERT INTO source_payloads (source_id, docs, file, file_ext) VALUES ($1,$2,$3,$4)", [
      sourceId,
      payload.docs ? JSON.stringify(payload.docs) : null,
      payload.file ? Buffer.from(payload.file) : null,
      payload.fileExt ?? null,
    ]);
  }
  kick();
}

/** Puts a source back in the queue (retry after failure, or re-index with a new embedding model). */
export async function requeueSource(sourceId: string): Promise<boolean> {
  const rows = await q(
    `UPDATE sources SET status = 'processing', error = NULL, attempts = 0, locked_until = NULL, run_after = now(), updated_at = now()
      WHERE id = $1 AND status <> 'processing' RETURNING id`,
    [sourceId]
  );
  if (rows.length) kick();
  return rows.length > 0;
}

/** Can this source be processed again? Websites always; files and text only if their content was kept. */
export async function canReprocess(source: { id: string; type: string; url: string | null }): Promise<boolean> {
  if (source.type === "url") return !!source.url;
  return !!(await q1("SELECT 1 FROM source_payloads WHERE source_id = $1 AND (docs IS NOT NULL OR file IS NOT NULL)", [source.id]));
}

export function isTransient(e: unknown): boolean {
  if (e instanceof PermanentIngestError) return false;
  if (e instanceof ProviderError) return e.retryable;
  const err = e as Error;
  if (e instanceof TypeError || err?.name === "TimeoutError" || err?.name === "AbortError") return true;
  return /failed with HTTP (5\d\d|429|408)|Could not resolve/.test(err?.message ?? "");
}

/** `chunk_count` > 0 means the source was indexed before: this run is a refresh (re-sync or re-index). */
type Job = { id: string; agent_id: string; type: string; url: string | null; crawl_pages: number; attempts: number; chunk_count: number };

/** Claims one due job, or null. */
async function claim(): Promise<Job | null> {
  return q1<Job>(
    `UPDATE sources SET attempts = attempts + 1, locked_until = now() + ($1 || ' minutes')::interval, updated_at = now()
      WHERE id = (
        SELECT id FROM sources
         WHERE status = 'processing' AND run_after <= now() AND (locked_until IS NULL OR locked_until < now())
         ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, agent_id, type, url, crawl_pages, attempts, chunk_count`,
    [String(LEASE_MINUTES)]
  );
}

async function docsFor(job: Job): Promise<Doc[]> {
  if (job.type === "url") {
    if (!job.url) throw new PermanentIngestError("This website source has no address");
    return fetchDocs(job.url, job.crawl_pages);
  }
  const p = await q1<{ docs: Doc[] | null; file: Buffer | null; file_ext: string | null }>("SELECT docs, file, file_ext FROM source_payloads WHERE source_id = $1", [job.id]);
  if (p?.docs) return p.docs;
  if (!p?.file) throw new PermanentIngestError("The original content of this source wasn't kept. Remove it and add it again.");
  const title = (await q1<{ title: string }>("SELECT title FROM sources WHERE id = $1", [job.id]))?.title ?? "upload";
  let text: string;
  let blocks: Block[] | undefined;
  const bytes = new Uint8Array(p.file);
  const ext = p.file_ext ?? "";
  // Scanned PDFs (almost no text layer) and photos are read by a vision model when OCR is set up.
  const readWithOcr = async (mime: string) => {
    if (!ocrConfigured()) {
      throw new PermanentIngestError(
        ext === "pdf"
          ? "This PDF looks scanned (it has no text in it). Upload a PDF with selectable text, or paste the text instead."
          : "Reading images needs OCR, which isn't set up on this server. Paste the text instead."
      );
    }
    const t0 = Date.now();
    const r = await ocr(bytes, mime, title);
    await recordOcr({ agentId: job.agent_id, model: r.model, usage: r.usage, ms: Date.now() - t0 });
    return normalizeText(r.text);
  };
  if (ext === "pdf") {
    let r: { text: string; pages: number; blocks: Block[] };
    try {
      r = await pdfText(bytes);
    } catch (e) {
      throw new PermanentIngestError(`Couldn't read this file: ${(e as Error).message}`);
    }
    if (!looksScanned(r)) (text = r.text), (blocks = r.blocks);
    else if (!r.text.trim()) text = await readWithOcr("application/pdf");
    else {
      // Some text, but very little: try OCR, and keep what the PDF had if OCR isn't available or fails.
      try {
        text = ocrConfigured() ? (await readWithOcr("application/pdf")) || r.text : r.text;
      } catch (e) {
        console.error("OCR failed, using the PDF's own text:", (e as Error).message);
        text = r.text;
      }
    }
  } else if (OCR_IMAGE_TYPES[ext]) {
    text = await readWithOcr(OCR_IMAGE_TYPES[ext]);
  } else {
    text = normalizeText(new TextDecoder("utf-8").decode(bytes));
    // CSV rows keep their column names; Markdown/TXT keep their headings, lists and tables.
    blocks = ext === "csv" ? csvToBlocks(new TextDecoder("utf-8").decode(bytes)) : textToBlocks(text);
  }
  const docs: Doc[] = [{ title, url: null, text, blocks: blocks ?? textToBlocks(text) }];
  // Keep the extracted text (for retries and re-indexing), not the file.
  await q("UPDATE source_payloads SET docs = $2, file = NULL WHERE source_id = $1", [job.id, JSON.stringify(docs)]);
  return docs;
}

async function run(job: Job): Promise<void> {
  try {
    const r = await writeChunks(job.id, job.agent_id, await docsFor(job));
    await q(
      `UPDATE sources SET status = 'ready', error = NULL, char_count = $2, chunk_count = $3, locked_until = NULL, last_synced_at = now(), updated_at = now()
        WHERE id = $1`,
      [job.id, r.chars, r.chunks]
    );
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 450);
    if (isTransient(e) && job.attempts < maxAttempts()) {
      const delay = retryBaseMs() * 2 ** (job.attempts - 1);
      await q(
        `UPDATE sources SET error = $2, locked_until = NULL, run_after = now() + ($3 || ' milliseconds')::interval, updated_at = now() WHERE id = $1`,
        [job.id, `Retrying (attempt ${job.attempts} of ${maxAttempts()} failed): ${message}`, String(delay)]
      );
      setTimeout(kick, delay + 50);
    } else if (job.chunk_count > 0) {
      // A refresh that failed: the previous passages are still there and searchable, so keep the source usable.
      await q("UPDATE sources SET status = 'ready', error = $2, locked_until = NULL, updated_at = now() WHERE id = $1", [
        job.id,
        `Last refresh failed (${new Date().toISOString().slice(0, 10)}): ${message}`.slice(0, 480),
      ]);
    } else {
      await q("UPDATE sources SET status = 'failed', error = $2, locked_until = NULL, updated_at = now() WHERE id = $1", [job.id, message]);
    }
  }
}

// ---- worker loop ---------------------------------------------------------------------------------------
const g = globalThis as unknown as { __ingest?: { running: number; timer?: NodeJS.Timeout; started: boolean } };
const state = (g.__ingest ??= { running: 0, started: false });

/** Starts as many jobs as there are free worker slots (INGEST_CONCURRENCY, default 2). */
export function kick(): void {
  if (!state.started) return;
  const slots = Math.max(1, envNum("INGEST_CONCURRENCY", 2));
  while (state.running < slots) {
    state.running++;
    void (async () => {
      try {
        const job = await claim();
        if (!job) return;
        await run(job);
        setImmediate(kick); // there may be more waiting
      } catch (e) {
        console.error("Ingestion worker error:", (e as Error).message);
      } finally {
        state.running--;
      }
    })();
    // One claim per free slot per kick; the loop exits because `running` rose.
  }
}

/** Called once per server process. Polls for due jobs (new ones also wake it immediately via kick()). */
/**
 * Queues website sources that haven't been read for SOURCE_RESYNC_DAYS (default 7; 0 = never), so answers follow the
 * site's changes. Thanks to content hashes, unchanged passages cost nothing. Safe with several servers (SKIP LOCKED).
 */
export async function scheduleResyncs(): Promise<number> {
  const days = envNum("SOURCE_RESYNC_DAYS", 7);
  if (days <= 0) return 0;
  const rows = await q(
    `UPDATE sources SET status = 'processing', attempts = 0, locked_until = NULL, run_after = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM sources
         WHERE type = 'url' AND status = 'ready' AND last_synced_at < now() - ($1 || ' days')::interval
         ORDER BY last_synced_at FOR UPDATE SKIP LOCKED LIMIT 20)
      RETURNING id`,
    [String(days)]
  );
  if (rows.length) kick();
  return rows.length;
}

export function startIngestWorker(): void {
  if (state.started || env("INGEST_WORKER")?.toLowerCase() === "off") return;
  state.started = true;
  state.timer = setInterval(kick, envNum("INGEST_POLL_MS", 3000));
  state.timer.unref?.();
  const resync = setInterval(() => void scheduleResyncs().catch((e) => console.error("Scheduling re-syncs failed:", (e as Error).message)), envNum("RESYNC_CHECK_MS", 10 * 60_000));
  resync.unref?.();
  kick();
}
