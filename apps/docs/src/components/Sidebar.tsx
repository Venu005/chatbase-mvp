"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import type { NavSection } from "@/lib/content";

/** The section-by-section page list. On phones it slides in from the menu button and closes on navigation. */
export default function Sidebar({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  useEffect(() => {
    delete document.documentElement.dataset.nav;
  }, [pathname]);
  return (
    <aside className="sidebar" id="sidebar" aria-label="Documentation">
      {sections.map((s) => (
        <div key={s.title} className="nav-group">
          <p className="nav-title">{s.title}</p>
          <ul>
            {s.pages.map((p) => {
              const href = `/${p.slug}`;
              const active = pathname === href || (p.slug === "" && pathname === "/");
              return (
                <li key={p.slug}>
                  <Link href={href} aria-current={active ? "page" : undefined}>
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </aside>
  );
}
