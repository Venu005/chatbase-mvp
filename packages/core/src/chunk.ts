// Recursive text splitter. Separators include the Devanagari danda ("।") so
// Hindi / Marathi / Bengali text splits on sentence boundaries too.
const SEPARATORS = ["\n\n", "\n", "। ", "।", ". ", "? ", "! ", "; ", ", ", " "];

function splitRec(text: string, size: number, seps: string[]): string[] {
  if (text.length <= size) return [text];
  const [sep, ...rest] = seps;
  if (sep === undefined) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }
  const parts = text.split(sep);
  if (parts.length === 1) return splitRec(text, size, rest);
  // Keep the separator attached to the left piece so no text is lost.
  const segs = parts.map((p, i) => (i < parts.length - 1 ? p + sep : p)).filter((s) => s.length > 0);
  return segs.flatMap((s) => (s.length <= size ? [s] : splitRec(s, size, rest)));
}

function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return overlap > 0 ? text : "";
  const tail = text.slice(-overlap);
  const space = tail.search(/\s/);
  return space > -1 ? tail.slice(space + 1) : tail;
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkText(input: string, size = 900, overlap = 120): string[] {
  const clean = normalizeText(input);
  if (!clean) return [];
  const segs = splitRec(clean, size, SEPARATORS);
  const chunks: string[] = [];
  let cur = "";
  for (const s of segs) {
    if (cur && (cur + s).length > size) {
      chunks.push(cur.trim());
      cur = overlapTail(cur, overlap) + s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  // Drop fragments that are too tiny to be useful, unless they're all we have.
  const useful = chunks.filter((c) => c.length >= 15);
  return useful.length ? useful : chunks;
}
