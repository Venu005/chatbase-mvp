/**
 * Lead capture helpers. Pure (no imports) so they are unit-tested.
 */

export const LEAD_FIELDS = ["name", "email", "phone"] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];
export type LeadMode = "off" | "after_first_answer" | "before_chat";

/** "+91 98765-43210" / "098765 43210" -> "+919876543210" / "09876543210"; null if it isn't a plausible phone number. */
export function normalizePhone(input: string): string | null {
  const t = input.trim();
  if (!/^\+?[\d\s().-]{7,25}$/.test(t)) return null;
  const digits = t.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return (t.startsWith("+") ? "+" : "") + digits;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const normalizeEmail = (input: string): string | null => {
  const t = input.trim().toLowerCase();
  return t.length <= 200 && EMAIL.test(t) ? t : null;
};

/** The free-text "phone or e-mail" a visitor leaves during a handoff, as a lead field. */
export function parseContact(contact: string): { email: string } | { phone: string } | null {
  const email = normalizeEmail(contact);
  if (email) return { email };
  const phone = normalizePhone(contact);
  return phone ? { phone } : null;
}

/**
 * One CSV cell. Quotes when needed, and defuses spreadsheet formulas (CSV injection): text starting with
 * = @ tab or CR, or + / - not followed by a digit, gets a leading apostrophe. Phone numbers like +91... stay as-is.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=@\t\r]/.test(s) || /^[+-](?![\d\s])/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
