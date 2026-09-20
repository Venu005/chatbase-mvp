import { Pool } from "pg";

// Reuse one pool across hot reloads in dev.
const g = globalThis as unknown as { __pool?: Pool };

export const pool: Pool =
  g.__pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") g.__pool = pool;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await pool.query(text, params as any[]);
  return res.rows as T[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function q1<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** pgvector text literal, e.g. "[0.1,0.2]" (use with a ::vector cast). */
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
