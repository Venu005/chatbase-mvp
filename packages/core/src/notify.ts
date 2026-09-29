import nodemailer, { type Transporter } from "nodemailer";
import { q1 } from "./db";
import { phoneFromSession } from "./handoff-intent";
import { env, envNum, envStr } from "./env";

/**
 * Emails the business owner when a customer needs a person. Configure SMTP_URL (see .env.example);
 * without it the app still works: the conversation shows up in the dashboard, and a line is logged.
 */

let transport: Transporter | null | undefined;
function getTransport(): Transporter | null {
  if (transport !== undefined) return transport;
  const url = env("SMTP_URL");
  if (!url) {
    console.warn("SMTP_URL is not set: handoff e-mails are skipped (conversations still appear in the dashboard).");
    return (transport = null);
  }
  return (transport = nodemailer.createTransport(url));
}

export const smtpConfigured = () => !!env("SMTP_URL");

/** Sends a plain-text e-mail. Returns false (and logs) when SMTP isn't configured or sending fails; never throws. */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const t = getTransport();
  if (!t) return false;
  try {
    await t.sendMail({ from: envStr("EMAIL_FROM", "Chatbase India <noreply@localhost>"), to, subject: subject.replace(/[\r\n]+/g, " "), text });
    return true;
  } catch (e) {
    console.error("E-mail failed:", (e as Error).message);
    return false;
  }
}

const COOLDOWN_MINUTES = envNum("HANDOFF_EMAIL_COOLDOWN_MINUTES", 15);

type Row = {
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  notify_email: boolean;
  owner_email: string;
  channel: string;
  session_id: string;
  visitor_contact: string | null;
};

/**
 * Sends at most one e-mail per conversation per cooldown window (unless `force`), so a chatty customer
 * does not flood the owner's inbox. Never throws.
 */
export async function notifyOwner(conversationId: string, opts: { force?: boolean; preview?: string; kind?: "handoff" | "message" | "contact" } = {}): Promise<void> {
  try {
    // Atomically claim the right to notify (prevents duplicate mails from concurrent messages).
    const claimed = await q1<{ id: string }>(
      `UPDATE conversations SET last_notified_at = now()
        WHERE id = $1 AND ($2::boolean OR last_notified_at IS NULL OR last_notified_at < now() - ($3 || ' minutes')::interval)
        RETURNING id`,
      [conversationId, !!opts.force, String(COOLDOWN_MINUTES)]
    );
    if (!claimed) return;

    const r = await q1<Row>(
      `SELECT c.id AS conversation_id, a.id AS agent_id, a.name AS agent_name, a.notify_email, u.email AS owner_email,
              c.channel, c.session_id, c.visitor_contact
         FROM conversations c JOIN agents a ON a.id = c.agent_id JOIN users u ON u.id = a.user_id
        WHERE c.id = $1`,
      [conversationId]
    );
    if (!r || !r.notify_email) return;
    if (!getTransport()) return;

    const base = envStr("APP_URL", "http://localhost:3000").replace(/\/$/, "");
    const link = `${base}/dashboard/agents/${r.agent_id}?c=${r.conversation_id}#chats`;
    const phone = phoneFromSession(r.session_id);
    const contact = phone ?? r.visitor_contact ?? "(not provided)";
    const where = r.channel === "whatsapp" ? "WhatsApp" : "your website chat";
    const subject =
      opts.kind === "contact" ? `[${r.agent_name}] A customer left their contact details` : `[${r.agent_name}] A customer is waiting for a reply`;
    const text = [
      opts.kind === "contact" ? `A customer on ${where} left their contact details.` : `A customer on ${where} needs a person to reply.`,
      "",
      `Contact: ${contact}`,
      opts.preview ? `Latest message: “${opts.preview.slice(0, 300)}”` : "",
      "",
      `Open the conversation and reply: ${link}`,
      "",
      "The assistant will stay quiet in this conversation until you hand it back.",
    ]
      .filter((l, i, arr) => l !== "" || arr[i - 1] !== "")
      .join("\n");

    await sendEmail(r.owner_email, subject, text);
  } catch (e) {
    console.error("Handoff e-mail failed:", (e as Error).message);
  }
}
