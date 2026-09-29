import { z } from "zod";
import { env } from "@chatbase/core/env";

// Shared by the admin API routes. Days are counted in Indian time; the owners' own playground tests are left out.
export const TZ = "Asia/Kolkata";
export const periodQuery = z.object({ days: z.enum(["1", "7", "30", "90"]).optional().default("7") });

/** SQL for "the start of the period": uses $1 = days and $2 = time zone, so queries using it take [days, TZ, ...]. */
export const SINCE = `((date_trunc('day', now() AT TIME ZONE $2) - (($1::int - 1) || ' days')::interval) AT TIME ZONE $2)`;

export const usdInrRate = () => (env("USD_INR_RATE") ? Number(env("USD_INR_RATE")) : null);
