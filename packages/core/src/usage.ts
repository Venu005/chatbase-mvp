import { q, q1 } from "./db";
import { planOf } from "./plans";

const period = () => new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)

/**
 * Atomically reserves one message credit. Returns false if the monthly limit is hit.
 * The WHERE clause on the upsert makes the check-and-increment race-free.
 */
export async function reserveCredit(userId: string, plan: string): Promise<boolean> {
  const limit = planOf(plan).credits;
  const rows = await q(
    `INSERT INTO usage (user_id, period, used) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, period) DO UPDATE SET used = usage.used + 1
     WHERE usage.used < $3
     RETURNING used`,
    [userId, period(), limit]
  );
  return rows.length > 0;
}

export async function refundCredit(userId: string): Promise<void> {
  await q("UPDATE usage SET used = GREATEST(used - 1, 0) WHERE user_id = $1 AND period = $2", [userId, period()]);
}

export async function getUsage(userId: string, plan: string) {
  const row = await q1<{ used: number }>("SELECT used FROM usage WHERE user_id = $1 AND period = $2", [userId, period()]);
  const p = planOf(plan);
  return { used: row?.used ?? 0, limit: p.credits, plan: p.name, agentLimit: p.agents };
}
