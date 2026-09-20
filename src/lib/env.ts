/**
 * Blank-safe environment access. When you copy .env.example to .env and leave an optional line empty
 * (`SMTP_URL=`), that must behave exactly like the variable not being set: no "" URLs, no NaN, no 0-limits.
 */
export function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export const envStr = (name: string, fallback: string): string => env(name) ?? fallback;

/** A number; unset, blank or non-numeric values fall back to the default. */
export function envNum(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** True for template values such as REPLACE_ME or change-me that were never filled in. */
export const isPlaceholder = (s: string): boolean => /replace[-_ ]?me|change[-_ ]?me/i.test(s);
