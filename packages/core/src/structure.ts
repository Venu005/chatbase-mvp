/**
 * Structure-aware chunking. Pure (no imports) so it is unit-tested.
 *
 * Sources are first turned into blocks (headings, paragraphs, lists, tables), keeping page numbers for PDFs. The chunker
 * then walks the blocks section by section, so every passage knows where it lives ("Returns › Electronics", page 4):
 *  - a passage never mixes two sections, and list items and table rows are never cut in half
 *  - table and CSV rows are written with their column names ("Product: Atta 5 kg · Code: AA-5K · Price: ₹265"),
 *    so a row still makes sense on its own
 *  - small-to-big: passages are small (precise search), but each carries its section (or its neighbours, for big
 *    sections) as `context`, which is what the model reads
 *  - sizes are in estimated tokens, not characters: Hindi and other Indic scripts use more tokens per character
 */

export type Block =
  | { kind: "heading"; level: number; text: string; page?: number }
  | { kind: "text"; text: string; page?: number }
  | { kind: "list"; items: string[]; page?: number }
  | { kind: "table"; header: string[]; rows: string[][]; page?: number };

export type Chunk = {
  /** The passage itself: what search matches against. */
  content: string;
  /** Headings above it, outermost first. */
  headingPath: string[];
  page: number | null;
  /** What the model reads when this passage is found: its whole section, or the passage with its neighbours. */
  context: string;
};

export type ChunkOptions = { maxTokens?: number; contextTokens?: number };

// ---- tokens ------------------------------------------------------------------------------------------------

/** Estimated tokens: about 4 characters per token for Latin script, about 2 for Devanagari and other Indic scripts. */
export function tokens(text: string): number {
  let latin = 0;
  let indic = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x0900 && c <= 0x0dff) indic++;
    else if (c > 0x20) latin++;
  }
  return Math.ceil(latin / 4 + indic / 2);
}

const clean = (s: string) =>
  s
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();

// ---- parsing plain text / Markdown -------------------------------------------------------------------------

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const LIST_ITEM = /^\s*(?:[-*•●▪]|\d{1,3}[.)])\s+(.+)$/;
/** A short line on its own ending with ":" ("Refund policy:") reads as a heading in pasted FAQs. */
const LABEL_HEADING = /^([^\n.?!:]{2,60}):$/;
const PIPE_ROW = /^\s*\|.*\|\s*$/;

function splitPipeRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** Plain text, Markdown or a pasted FAQ → blocks. */
export function textToBlocks(input: string, page?: number): Block[] {
  const lines = clean(input).split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "text", text: para.join(" ").trim(), ...(page ? { page } : {}) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      flush();
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(MD_HEADING))) {
      flush();
      blocks.push({ kind: "heading", level: m[1].length, text: m[2], ...(page ? { page } : {}) });
    } else if ((m = line.match(LABEL_HEADING)) && para.length === 0) {
      flush();
      blocks.push({ kind: "heading", level: 3, text: m[1].trim(), ...(page ? { page } : {}) });
    } else if (PIPE_ROW.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const header = splitPipeRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && PIPE_ROW.test(lines[i])) rows.push(splitPipeRow(lines[i++]));
      i--;
      blocks.push({ kind: "table", header, rows, ...(page ? { page } : {}) });
    } else if ((m = line.match(LIST_ITEM))) {
      flush();
      const items = [m[1].trim()];
      while (i + 1 < lines.length && (m = lines[i + 1].trim().match(LIST_ITEM))) items.push(m[1].trim()), i++;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.page === page) last.items.push(...items);
      else blocks.push({ kind: "list", items, ...(page ? { page } : {}) });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

// ---- CSV ---------------------------------------------------------------------------------------------------

/** RFC 4180-ish CSV parser (quotes, escaped quotes, commas/newlines inside quotes, ; or tab separators). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  const sep = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) row.push(cell.trim()), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) rows.push(row);
  return rows;
}

export function csvToBlocks(input: string): Block[] {
  const rows = parseCsv(input);
  if (!rows.length) return [];
  const [header, ...body] = rows;
  return [{ kind: "table", header: header.map((h, i) => h || `Column ${i + 1}`), rows: body }];
}

// ---- PDF pages ---------------------------------------------------------------------------------------------

/**
 * PDF pages → blocks with page numbers. Lines that repeat at the top or bottom of most pages (running headers,
 * footers, "Page 3 of 12") are dropped, so they don't become passages of their own.
 */
export function pagesToBlocks(pages: string[]): Block[] {
  const norm = (l: string) => l.trim().toLowerCase().replace(/\d+/g, "#");
  const edges = new Map<string, number>();
  const pageLines = pages.map((p) => clean(p).split("\n").filter((l) => l.trim()));
  if (pages.length >= 2) {
    for (const lines of pageLines) {
      const seen = new Set<string>();
      for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) seen.add(norm(l));
      for (const k of seen) edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  const repeated = new Set([...edges].filter(([, n]) => n >= Math.max(2, pages.length * 0.5)).map(([k]) => k));
  return pageLines.flatMap((lines, i) =>
    textToBlocks(
      lines
        .filter((l, j) => !((j < 2 || j >= lines.length - 2) && repeated.has(norm(l))))
        // PDF text often breaks lines mid-sentence: join lines unless the next one looks like a new item or heading.
        .join("\n")
        .replace(/([^\n.:;!?।])\n(?=[a-zऀ-ॿ])/g, "$1 "),
      i + 1
    )
  );
}

// ---- chunking ----------------------------------------------------------------------------------------------

/** A table row with its column names, so it makes sense on its own. */
export function rowText(header: string[], row: string[]): string {
  return row
    .map((v, i) => [header[i] ?? `Column ${i + 1}`, v] as const)
    .filter(([, v]) => v)
    .map(([h, v]) => `${h}: ${v}`)
    .join(" · ");
}

/** Splits an over-long paragraph at sentence ends (., ?, !, ।), then at spaces. */
function splitLong(text: string, maxTokens: number): string[] {
  if (tokens(text) <= maxTokens) return [text];
  const sentences = text.match(/[^.?!।]+(?:[.?!।]+|$)\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (tokens(s) > maxTokens) {
      if (cur) out.push(cur.trim()), (cur = "");
      const words = s.split(/(\s+)/);
      for (const w of words) {
        if (cur && tokens(cur + w) > maxTokens) out.push(cur.trim()), (cur = "");
        cur += w;
      }
    } else if (cur && tokens(cur + s) > maxTokens) {
      out.push(cur.trim());
      cur = s;
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

type Unit = { text: string; page?: number; sep: string };

/** Cuts a text to about `max` tokens, at a line or sentence end when possible. */
function truncateTokens(text: string, max: number): string {
  if (tokens(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tokens(text.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const end = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf("। "));
  return (end > lo * 0.6 ? cut.slice(0, end + 1) : cut).trim() + " …";
}

export function chunkBlocks(blocks: Block[], opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? 180;
  const contextTokens = opts.contextTokens ?? 600;
  const chunks: Chunk[] = [];
  const path: { level: number; text: string }[] = [];
  let units: Unit[] = [];

  const emitSection = () => {
    if (!units.length) return;
    const headingPath = path.map((h) => h.text);
    // Pack units into passages of at most maxTokens.
    const passages: { text: string; page: number | null }[] = [];
    let cur = "";
    let page: number | null = null;
    for (const u of units) {
      for (const piece of splitLong(u.text, maxTokens)) {
        // A passage never spans two PDF pages, so its page number is always right.
        if (cur && (tokens(cur + u.sep + piece) > maxTokens || (u.page ?? null) !== page)) {
          passages.push({ text: cur, page });
          cur = "";
        }
        if (!cur) page = u.page ?? null;
        cur = cur ? cur + u.sep + piece : piece;
      }
    }
    if (cur) passages.push({ text: cur, page });

    const sectionText = passages.map((p) => p.text).join("\n");
    const whole = tokens(sectionText) <= contextTokens;
    passages.forEach((p, i) => {
      // Small-to-big: the whole section when it fits, otherwise this passage with its neighbours.
      const context = whole
        ? sectionText
        : truncateTokens([passages[i - 1]?.text, p.text, passages[i + 1]?.text].filter(Boolean).join("\n"), contextTokens);
      chunks.push({ content: p.text, headingPath, page: p.page, context });
    });
    units = [];
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      emitSection();
      while (path.length && path[path.length - 1].level >= b.level) path.pop();
      path.push({ level: b.level, text: b.text });
    } else if (b.kind === "text") units.push({ text: b.text, page: b.page, sep: "\n" });
    else if (b.kind === "list") for (const item of b.items) units.push({ text: `• ${item}`, page: b.page, sep: "\n" });
    else if (b.kind === "table") for (const r of b.rows) units.push({ text: rowText(b.header, r), page: b.page, sep: "\n" });
  }
  emitSection();
  return chunks.filter((c) => c.content.trim().length > 1);
}

// ---- building the model's context from found passages -----------------------------------------------------

export type Found = { id: number; title: string; url: string | null; headingPath: string; page: number | null; content: string; context: string | null };
export type ContextGroup = { n: number; label: string; url: string | null; page: number | null; text: string; ids: number[] };

/**
 * Turns ranked passages into the numbered context blocks the model reads (and the citations it can use):
 *  - each passage brings its context (section or neighbours) instead of just itself
 *  - passages from the same section, or already inside an earlier block, are merged instead of repeated
 *  - blocks stop at `budgetTokens` in total, so a question never costs more than planned
 */
export function groupContext(found: Found[], budgetTokens = 2400): ContextGroup[] {
  const groups: ContextGroup[] = [];
  let used = 0;
  for (const f of found) {
    const text = f.context ?? f.content;
    const same = groups.find((g) => g.text === text || g.text.includes(f.content));
    if (same) {
      same.ids.push(f.id);
      continue;
    }
    const cost = tokens(text);
    if (groups.length && used + cost > budgetTokens) continue;
    used += cost;
    const section = f.headingPath ? f.headingPath.split(" › ").slice(-2).join(" › ") : "";
    const label = [f.title, section].filter(Boolean).join(" › ") + (f.page ? ` (page ${f.page})` : "");
    groups.push({ n: groups.length + 1, label, url: f.url, page: f.page, text, ids: [f.id] });
  }
  return groups;
}
