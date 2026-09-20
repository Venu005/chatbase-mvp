/**
 * Some reasoning models put their chain of thought inside <think>...</think> in the reply text. Customers must
 * never see that, so this streaming filter drops those blocks, including when a tag is split across chunks.
 * Pure (no imports) so it is unit-tested.
 */
const OPEN = "<think>";
const CLOSE = "</think>";

/** Length of the longest suffix of `s` that is a proper prefix of `tag` (a tag that may still be arriving). */
function partialSuffix(s: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (s.endsWith(tag.slice(0, k))) return k;
  return 0;
}

export function createThinkFilter() {
  let buf = "";
  let inThink = false;
  let trimNext = false; // drop the blank lines the model leaves after </think>

  function drain(final: boolean): string {
    let out = "";
    for (;;) {
      if (!inThink) {
        const i = buf.indexOf(OPEN);
        if (i >= 0) {
          out += buf.slice(0, i);
          buf = buf.slice(i + OPEN.length);
          inThink = true;
          continue;
        }
        const keep = final ? 0 : partialSuffix(buf, OPEN);
        out += buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        break;
      }
      const i = buf.indexOf(CLOSE);
      if (i >= 0) {
        buf = buf.slice(i + CLOSE.length);
        inThink = false;
        trimNext = true;
        continue;
      }
      const keep = final ? 0 : partialSuffix(buf, CLOSE);
      buf = buf.slice(buf.length - keep);
      break;
    }
    if (trimNext && out) {
      out = out.replace(/^\s+/, "");
      if (out) trimNext = false;
    }
    return out;
  }

  return {
    push(chunk: string): string {
      buf += chunk;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}
