import { q, q1 } from "./db";
import { env, envNum } from "./env";
import { sendEmail } from "./notify";

/**
 * Operational alerts for the platform operator: answers failing, answers slow, the backup model doing most of the
 * work, ingestion stuck. Evaluated over the last ALERT_WINDOW_MINUTES; each alert is e-mailed to the admins at most
 * once per ALERT_COOLDOWN_MINUTES (across all servers), and shown in the admin app while it lasts.
 */
export type Alert = { key: string; level: "critical" | "warning"; message: string };

export async function currentAlerts(): Promise<Alert[]> {
  const minutes = envNum("ALERT_WINDOW_MINUTES", 15);
  const minAnswers = envNum("ALERT_MIN_ANSWERS", 20);
  const [a, ing] = await Promise.all([
    q1<{ answers: number; errors: number; fallbacks: number; p95: number | null }>(
      `SELECT count(*)::int AS answers,
              count(*) FILTER (WHERE status = 'error')::int AS errors,
              count(*) FILTER (WHERE fallback_used)::int AS fallbacks,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE status = 'ok' AND provider <> 'cache'))::int AS p95
         FROM ai_calls WHERE kind = 'answer' AND created_at >= now() - make_interval(mins => $1)`,
      [minutes]
    ),
    q1<{ stuck: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'processing' AND run_after < now() - interval '30 minutes' AND (locked_until IS NULL OR locked_until < now()))::int AS stuck,
              count(*) FILTER (WHERE status = 'failed' AND updated_at >= now() - make_interval(mins => $1))::int AS failed
         FROM sources`,
      [minutes]
    ),
  ]);
  const alerts: Alert[] = [];
  const window = `in the last ${minutes} minutes`;
  if (a && a.answers >= minAnswers) {
    const errRate = a.errors / a.answers;
    if (errRate > envNum("ALERT_ERROR_RATE", 0.05))
      alerts.push({ key: "answer_errors", level: "critical", message: `${Math.round(errRate * 100)}% of answers failed ${window} (${a.errors} of ${a.answers}).` });
    if (a.p95 !== null && a.p95 > envNum("ALERT_P95_MS", 8000))
      alerts.push({ key: "slow_answers", level: "warning", message: `Slow answers: 95% of visitors got the first word within ${(a.p95 / 1000).toFixed(1)} s ${window}.` });
    const fb = a.fallbacks / a.answers;
    if (fb > envNum("ALERT_FALLBACK_RATE", 0.3))
      alerts.push({ key: "backup_model", level: "warning", message: `The backup model wrote ${Math.round(fb * 100)}% of answers ${window}: the main model is failing.` });
  }
  if (ing && ing.stuck > 0)
    alerts.push({ key: "ingestion_stuck", level: "critical", message: `${ing.stuck} source${ing.stuck === 1 ? " has" : "s have"} waited over 30 minutes to be read: is an ingestion worker running?` });
  if (ing && ing.failed >= envNum("ALERT_FAILED_SOURCES", 5))
    alerts.push({ key: "sources_failing", level: "warning", message: `${ing.failed} sources failed to load ${window}.` });
  return alerts;
}

/** Who gets alert e-mails: ALERT_EMAILS, or else every admin. */
async function recipients(): Promise<string[]> {
  const list = env("ALERT_EMAILS") ?? "";
  if (list) return list.split(",").map((e) => e.trim()).filter(Boolean);
  const rows = await q<{ email: string }>("SELECT email FROM admins");
  const fromEnv = (env("ADMIN_EMAILS") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...rows.map((r) => r.email), ...fromEnv])];
}

/** Checks the alerts and e-mails the ones not sent within the cooldown. Returns the current alerts and the sent keys. */
export async function checkAlerts(): Promise<{ alerts: Alert[]; sent: string[] }> {
  const alerts = await currentAlerts();
  const sent: string[] = [];
  const cooldown = envNum("ALERT_COOLDOWN_MINUTES", 60);
  for (const al of alerts) {
    // Claiming the alert row first makes sure only one server sends it.
    const claimed = await q1(
      `INSERT INTO ops_alerts (key, last_sent_at, last_message) VALUES ($1, now(), $2)
       ON CONFLICT (key) DO UPDATE SET last_sent_at = now(), last_message = $2
       WHERE ops_alerts.last_sent_at < now() - make_interval(mins => $3)
       RETURNING key`,
      [al.key, al.message, cooldown]
    );
    if (!claimed) continue;
    const to = await recipients();
    if (to.length && (await sendEmail(to.join(", "), `[${al.level === "critical" ? "Critical" : "Warning"}] Chatbase India: ${al.message.split(":")[0]}`, `${al.message}\n\nOpen the admin app for details: ${env("ADMIN_URL") ?? "(set ADMIN_URL)"}\n`)))
      sent.push(al.key);
  }
  return { alerts, sent };
}

let started = false;
/** Runs checkAlerts every ALERT_CHECK_MS (default 5 minutes). ALERTS=off turns it off. */
export function startAlertChecks(): void {
  if (started || env("ALERTS")?.toLowerCase() === "off") return;
  started = true;
  const t = setInterval(() => void checkAlerts().catch((e) => console.error("Alert check failed:", (e as Error).message)), envNum("ALERT_CHECK_MS", 5 * 60_000));
  t.unref?.();
}
