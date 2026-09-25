import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "@/lib/markdown";

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.v}</Fragment>;
      case "b":
        return <strong key={i}>{inline(n.c)}</strong>;
      case "i":
        return <em key={i}>{inline(n.c)}</em>;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "a":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {inline(n.c)}
          </a>
        );
    }
  });
}

/** Renders a chat answer's Markdown as React elements (no raw HTML is ever injected). */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseMarkdown(text).map((b, i) => {
        switch (b.t) {
          case "p":
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l)}
                  </Fragment>
                ))}
              </p>
            );
          case "h":
            return (
              <p key={i}>
                <strong>{inline(b.c)}</strong>
              </p>
            );
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            );
          case "pre":
            return <pre key={i}>{b.v}</pre>;
        }
      })}
    </div>
  );
}
