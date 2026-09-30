import { z } from "zod";
import { env } from "@chatbase/core/env";
import { q } from "@chatbase/core/db";

// Shared by the admin API routes. Days are counted in Indian time; the owners' own playground tests are left out.
export const TZ = "Asia/Kolkata";
export const periodQuery = z.object({ days: z.enum(["1", "7", "30", "90"]).optional().default("7") });

/** SQL for "the start of the period": uses $1 = days and $2 = time zone, so queries using it take [days, TZ, ...]. */
export const SINCE = `((date_trunc('day', now() AT TIME ZONE $2) - (($1::int - 1) || ' days')::interval) AT TIME ZONE $2)`;

export const usdInrRate = () => (env("USD_INR_RATE") ? Number(env("USD_INR_RATE")) : null);

/** ₹ per US$ for profit figures: USD_INR_RATE, or an assumed 85 (the response says when it's assumed). */
export const profitRate = () => ({ rate: usdInrRate() ?? 85, assumed: usdInrRate() === null });

/** Records an admin action (changes, and looking at customers' conversations) in the audit log. Never throws. */
export async function audit(
  admin: { id: string; email: string },
  action: string,
  target: { id: string; email: string } | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await q(
      "INSERT INTO admin_audit (admin_id, admin_email, action, target_user_id, target_email, details) VALUES ($1, $2, $3, $4, $5, $6)",
      [admin.id, admin.email, action, target?.id ?? null, target?.email ?? null, JSON.stringify(details)]
    );
  } catch (e) {
    console.error("Audit log write failed:", (e as Error).message);
  }
}
