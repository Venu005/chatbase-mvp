"use client";

import { useEffect, useState } from "react";
import type { TocItem } from "@/lib/content";

/** "On this page", highlighting the section being read. */
export default function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" }
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [items]);
  if (items.length < 2) return null;
  return (
    <nav className="toc" aria-label="On this page">
      <p className="nav-title">On this page</p>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={i.level === 3 ? "sub" : undefined}>
            <a href={`#${i.id}`} aria-current={active === i.id ? "location" : undefined}>
              {i.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
