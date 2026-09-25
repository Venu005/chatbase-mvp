/**
 * Allowed websites for an agent's chat widget. Pure (no imports) so it is unit-tested.
 * An entry "example.com" allows example.com and every subdomain (www.example.com, shop.example.com).
 * An empty list allows any website.
 */

export const MAX_ALLOWED_DOMAINS = 20;

/** "https://www.Example.com/contact" -> "www.example.com"; anything that isn't a plausible hostname -> null. */
export function normalizeDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (host === "localhost") return host;
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host) ? host : null;
}

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (!allowed.length) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Host of a Referer/Origin header value, or null when missing or unparsable. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * May the chat page (/embed/:id) be shown in this navigation? Browsers can't be made to lie about these
 * headers, so a site that isn't on the list can't frame the chat and spend the owner's message credits.
 *  - Sec-Fetch-Dest "document": someone opened the full-page chat link directly; always fine.
 *  - Framed: the parent page (Referer; widget.js sends at least the origin) must be an allowed website.
 *  - Older browsers without Sec-Fetch-*: judge by the Referer when there is one.
 */
export function embedAllowed(o: { allowed: readonly string[]; dest: string | null; referer: string | null; selfHost: string | null }): boolean {
  if (!o.allowed.length || o.dest === "document") return true;
  const ref = hostOf(o.referer);
  if (ref) return ref === o.selfHost || hostAllowed(ref, o.allowed);
  return !o.dest; // framed with the Referer stripped: refuse
}
