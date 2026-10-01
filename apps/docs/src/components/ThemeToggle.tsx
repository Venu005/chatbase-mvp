"use client";

import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";
const NEXT: Record<Mode, Mode> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Mode, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

/** Cycles system → light → dark; remembered in this browser. */
export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    if (t === "light" || t === "dark") setMode(t);
  }, []);
  function cycle() {
    const m = NEXT[mode];
    setMode(m);
    if (m === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = m;
    try {
      if (m === "system") localStorage.removeItem("docs-theme");
      else localStorage.setItem("docs-theme", m);
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
  }
  return (
    <button type="button" className="icon-btn" onClick={cycle} aria-label={LABEL[mode]} title={LABEL[mode]}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        {mode === "dark" ? (
          <path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" />
        ) : mode === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
          </>
        )}
      </svg>
    </button>
  );
}
