"use client";

/** Phones: opens and closes the sidebar. */
export default function MenuButton() {
  const toggle = () => {
    const el = document.documentElement;
    if (el.dataset.nav === "open") delete el.dataset.nav;
    else el.dataset.nav = "open";
  };
  return (
    <button type="button" className="menu-btn" aria-label="Menu" aria-controls="sidebar" onClick={toggle}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  );
}
