/**
 * Turning a streamed text answer into speakable sentences (pure, unit-tested): markdown, [n] citations and links
 * are removed, and text is released one sentence at a time so speech can start before the answer is finished.
 */

/** Written-answer formatting → plain speech. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\[(\d+)\]/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "our website")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/₹\s?/g, "₹")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,!?।])/g, "$1")
    .replace(/ +\n/g, "\n")
    .trim();
}

/** Collects streamed text and hands out whole sentences (at . ! ? । or a line break), at least `min` characters long. */
export class SentenceSplitter {
  private buf = "";
  private min: number;
  constructor(min = 24) {
    this.min = min;
  }

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      // A sentence end: punctuation followed by a space/newline, or a line break. "Rs. 50" and "2.5 kg" don't split.
      const re = /([.!?।]+)(?=\s)|\n+/g;
      let cut = -1;
      for (let m = re.exec(this.buf); m; m = re.exec(this.buf)) {
        const end = m.index + m[0].length;
        const before = this.buf.slice(0, m.index);
        if (m[0].startsWith(".") && /\b(rs|mr|mrs|dr|no|st|approx|etc)$/i.test(before)) continue;
        if (end >= this.min) {
          cut = end;
          break;
        }
      }
      if (cut < 0) break;
      const s = cleanForSpeech(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
      if (s) out.push(s);
    }
    return out;
  }

  /** The rest, when the answer is complete. */
  flush(): string[] {
    const s = cleanForSpeech(this.buf);
    this.buf = "";
    return s ? [s] : [];
  }
}
