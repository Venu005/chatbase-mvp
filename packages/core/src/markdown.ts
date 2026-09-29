/**
 * A deliberately small Markdown parser for chat answers: paragraphs, headings, bullet/numbered lists, code
 * blocks, **bold**, *italic*, `code` and links. It returns a tree (never HTML), so the React renderer can't
 * inject markup, and it's pure so it is unit-tested. Unclosed syntax (common mid-stream) stays as plain text.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "b" | "i"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "a"; href: string; c: Inline[] };

export type Block =
  | { t: "p"; lines: Inline[][] }
  | { t: "h"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "pre"; v: string };

// Order matters: code spans first (their content is literal), then links, bold, italic, bare URLs.
// No lookbehind: it is a syntax error on iOS Safari < 16.4, which would break the whole widget there.
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(\S(?:.*?\S)?)\*\*|\*([^\s*](?:[^*\n]*?[^\s*])?)\*|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const text = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v += v;
    else out.push({ t: "text", v });
  };
  let at = 0;
  for (const m of src.matchAll(INLINE)) {
    text(src.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "a", href: m[3], c: parseInline(m[2]) });
    else if (m[4] !== undefined) out.push({ t: "b", c: parseInline(m[4]) });
    else if (m[5] !== undefined) out.push({ t: "i", c: parseInline(m[5]) });
    else out.push({ t: "a", href: m[6], c: [{ t: "text", v: m[6] }] });
  }
  text(src.slice(at));
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*```/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let para: Inline[][] | null = null;
  const endPara = () => (para = null);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      endPara();
      const body: string[] = [];
      while (++i < lines.length && !FENCE.test(lines[i])) body.push(lines[i]);
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    if (!line.trim() || RULE.test(line)) {
      endPara();
      continue;
    }
    const last = blocks[blocks.length - 1];
    let m: RegExpMatchArray | null;
    if ((m = line.match(HEADING))) {
      endPara();
      blocks.push({ t: "h", c: parseInline(m[1]) });
    } else if ((m = line.match(BULLET))) {
      endPara();
      if (last?.t === "ul") last.items.push(parseInline(m[1]));
      else blocks.push({ t: "ul", items: [parseInline(m[1])] });
    } else if ((m = line.match(NUMBERED))) {
      endPara();
      if (last?.t === "ol") last.items.push(parseInline(m[2]));
      else blocks.push({ t: "ol", start: Number(m[1]), items: [parseInline(m[2])] });
    } else if (para) {
      para.push(parseInline(line.trim()));
    } else {
      para = [parseInline(line.trim())];
      blocks.push({ t: "p", lines: para });
    }
  }
  return blocks;
}
