/** Heuristics for sources that need extra help to read. Pure (no imports) so they are unit-tested. */

/** A PDF with (almost) no text layer is a scan: fewer than 25 characters per page (a short real PDF has more). */
export const looksScanned = (r: { text: string; pages: number }) => r.text.trim().length < 25 * Math.max(1, r.pages);

/**
 * A page whose HTML is an empty app shell (React/Next/Vue/Wix...) that builds its text with JavaScript: little text,
 * scripts present, and a typical mount point or "enable JavaScript" notice.
 */
export function looksClientRendered(html: string, textLength: number): boolean {
  if (textLength >= 200 || !/<script[\s>]/i.test(html)) return false;
  return /id=["'](root|app|__next|__nuxt|svelte|main-app)["']|enable javascript|requires javascript|wix-|data-reactroot|ng-version/i.test(html) || textLength < 30;
}
