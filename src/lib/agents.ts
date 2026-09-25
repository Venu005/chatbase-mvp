import { q, q1 } from "./db";
import { HttpError } from "./http";
import { indexDocs, type Doc } from "./ingest";

export type Agent = {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  welcome_message: string;
  brand_color: string;
  handoff_enabled: boolean;
  handoff_message: string;
  notify_email: boolean;
  allowed_domains: string[];
  created_at: string;
};

/** Loads an agent only if it belongs to the user (multi-tenant guard used by every dashboard route). */
export async function ownAgent(userId: string, agentId: string): Promise<Agent> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new HttpError(404, "Agent not found");
  const a = await q1<Agent>("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [agentId, userId]);
  if (!a) throw new HttpError(404, "Agent not found");
  return a;
}

/**
 * Runs ingestion after the HTTP response has been sent; the UI polls source status.
 * This works on a long-lived Node server (`next start`, Docker, a VM). On serverless
 * platforms, move this to a real queue/worker (pg-boss, BullMQ, Inngest, ...).
 */
/** A source still "processing" after this long lost its background job (server restart or crash). */
const STALE_MINUTES = 20;

/** Marks this agent's orphaned "processing" sources as failed, so the UI stops waiting and offers a retry. */
export async function failStaleSources(agentId: string): Promise<void> {
  await q(
    `UPDATE sources SET status = 'failed', error = 'Processing was interrupted (the server restarted). Retry it, or remove it and add it again.'
      WHERE agent_id = $1 AND status = 'processing' AND updated_at < now() - ($2 || ' minutes')::interval`,
    [agentId, String(STALE_MINUTES)]
  );
}

export function ingestInBackground(sourceId: string, agentId: string, getDocs: () => Promise<Doc[]>) {
  void (async () => {
    try {
      await indexDocs(sourceId, agentId, await getDocs());
    } catch (e) {
      await q("UPDATE sources SET status='failed', error=$2, updated_at=now() WHERE id=$1", [sourceId, String((e as Error).message).slice(0, 500)]).catch(() => {});
    }
  })();
}
