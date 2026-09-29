import { q1 } from "./db";
import { sendEmail } from "./notify";
import { envStr } from "./env";

export type LeadInput = { name?: string | null; email?: string | null; phone?: string | null };

/**
 * Saves (or completes) the lead for one visitor session. Values already on file are only replaced by new,
 * non-empty ones, so a later "phone only" form never wipes a name. E-mails the owner the first time a
 * visitor fills in the lead form (if they have e-mail alerts on). Never throws on the e-mail.
 */
export async function upsertLead(
  agentId: string,
  sessionId: string,
  channel: string,
  source: "form" | "handoff" | "whatsapp",
  lead: LeadInput
): Promise<{ id: string; created: boolean }> {
  const row = (await q1<{ id: string; created: boolean }>(
    `INSERT INTO leads (agent_id, session_id, channel, source, name, email, phone) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (agent_id, session_id) DO UPDATE SET
       name  = COALESCE(EXCLUDED.name,  leads.name),
       email = COALESCE(EXCLUDED.email, leads.email),
       phone = COALESCE(EXCLUDED.phone, leads.phone),
       updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [agentId, sessionId, channel, source, lead.name || null, lead.email || null, lead.phone || null]
  ))!;
  // Only the lead form e-mails: WhatsApp numbers become leads on every first message, and a handoff already
  // sends its own e-mail with the contact details.
  if (row.created && source === "form") void notifyNewLead(agentId, lead);
  return row;
}

async function notifyNewLead(agentId: string, lead: LeadInput) {
  try {
    const r = await q1<{ name: string; notify_email: boolean; email: string }>(
      "SELECT a.name, a.notify_email, u.email FROM agents a JOIN users u ON u.id = a.user_id WHERE a.id = $1",
      [agentId]
    );
    if (!r?.notify_email) return;
    const link = `${envStr("APP_URL", "http://localhost:3000").replace(/\/$/, "")}/dashboard/agents/${agentId}#leads`;
    await sendEmail(
      r.email,
      `[${r.name}] New lead${lead.name ? `: ${lead.name}` : ""}`,
      [
        "A visitor on your website chat left their details.",
        "",
        lead.name ? `Name: ${lead.name}` : null,
        lead.email ? `E-mail: ${lead.email}` : null,
        lead.phone ? `Phone: ${lead.phone}` : null,
        "",
        `All leads: ${link}`,
      ]
        .filter((l): l is string => typeof l === "string")
        .join("\n")
    );
  } catch (e) {
    console.error("Lead e-mail failed:", (e as Error).message);
  }
}
