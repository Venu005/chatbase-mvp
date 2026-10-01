"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { SearchEntry } from "@/lib/content";

/** Ranks entries containing every word of the query: words in the heading count most, then the page title. */
function rank(entries: SearchEntry[], query: string): SearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return entries
    .map((e) => {
      const h = e.heading.toLowerCase();
      const p = e.page.toLowerCase();
      const all = `${h} ${p} ${e.text.toLowerCase()}`;
      if (!words.every((w) => all.includes(w))) return null;
      const score = words.reduce((s, w) => s + (h.includes(w) ? 10 : 0) + (p.includes(w) ? 4 : 0) + (e.text.toLowerCase().includes(w) ? 1 : 0), 0);
      return { e, score };
    })
    .filter((x): x is { e: SearchEntry; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.e);
}

function snippet(text: string, query: string): string {
  const w = query.toLowerCase().split(/\s+/).find(Boolean) ?? "";
  const i = Math.max(0, text.toLowerCase().indexOf(w));
  const start = Math.max(0, i - 50);
  return (start ? "…" : "") + text.slice(start, start + 150) + (text.length > start + 150 ? "…" : "");
}

/** Search across every page. Opens with the button, "/" or Ctrl/⌘ K. */
export default function Search() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState<SearchEntry[] | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const show = useCallback(() => {
    setOpen(true);
    if (!index) fetch("/search-index.json").then((r) => r.json()).then(setIndex, () => setIndex([]));
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        show();
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const results = useMemo(() => (index ? rank(index, q) : []), [index, q]);
  useEffect(() => setSel(0), [q]);

  function go(e: SearchEntry) {
    setOpen(false);
    setQ("");
    router.push(`/${e.slug}${e.anchor ? `#${e.anchor}` : ""}`);
  }

  return (
    <>
      <button type="button" className="search-btn" onClick={show}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>Search docs</span>
        <kbd>/</kbd>
      </button>
      {open &&
        // Rendered into <body>: inside the blurred header, "position: fixed" would be relative to the header.
        createPortal(
        <div className="search-backdrop" onClick={() => setOpen(false)}>
          <div className="search-panel" role="dialog" aria-modal="true" aria-label="Search the docs" onClick={(e) => e.stopPropagation()}>
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search: WhatsApp, refund, voice, GST…"
              aria-label="Search"
              aria-controls="search-results"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, results.length - 1)));
                else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
                else if (e.key === "Enter" && results[sel]) go(results[sel]);
              }}
            />
            <ul id="search-results" role="listbox" aria-label="Results">
              {!index && <li className="muted search-empty">Loading…</li>}
              {index && q.trim() && results.length === 0 && <li className="muted search-empty">Nothing found for “{q}”.</li>}
              {results.map((r, i) => (
                <li key={`${r.slug}#${r.anchor}`} role="option" aria-selected={i === sel}>
                  <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(r)}>
                    <span className="search-where">
                      {r.page}
                      {r.heading !== r.page && <> › <b>{r.heading}</b></>}
                    </span>
                    {r.text && <span className="search-snippet">{snippet(r.text, q)}</span>}
                  </button>
                </li>
              ))}
            </ul>
            <p className="search-help muted">↑ ↓ to move · Enter to open · Esc to close</p>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
