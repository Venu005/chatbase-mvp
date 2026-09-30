// Number, money and time formatting for the admin app (Indian conventions: lakh, crore, en-IN dates).
export const n = (v: number | string) => Number(v).toLocaleString("en-IN");
/** 950 · 12.4K · 3.2L (lakh) · 1.5Cr (crore) */
export function compact(v: number | string): string {
  const x = Number(v);
  const f = (d: number, u: string) => `${(x / d).toFixed(x / d < 10 ? 1 : 0).replace(/\.0$/, "")}${u}`;
  return x < 1000 ? x.toLocaleString("en-IN") : x < 100_000 ? f(1000, "K") : x < 10_000_000 ? f(100_000, "L") : f(10_000_000, "Cr");
}
export const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : "–");
export const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
export const when = (d: string | null) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");
export function usd(v: number | null | undefined, rate: number | null): string {
  if (v === null || v === undefined) return "no price";
  const d = v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  return rate ? `${d} · ₹${(v * rate).toFixed(v * rate < 1 ? 2 : 0)}` : d;
}

/** ₹ amounts: ₹1,234 · ₹12.5K · ₹3.2L · ₹1.5Cr */
export function inr(v: number): string {
  const a = Math.abs(v);
  return `${v < 0 ? "−" : ""}₹${a < 1000 ? a.toLocaleString("en-IN", { maximumFractionDigits: a < 10 ? 2 : 0 }) : compact(a)}`;
}
/** 0.123 → "12%" (null → "–") */
export const share = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
