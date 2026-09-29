/** Small fetch wrapper for the dashboard: JSON in/out, throws Error(message) on failure. */
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers: init.body && !isForm ? { "content-type": "application/json", ...(init.headers ?? {}) } : init.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function json(body: unknown): { body: string } {
  return { body: JSON.stringify(body) };
}
