import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { nav, site } from "@/lib/content";
import Sidebar from "@/components/Sidebar";
import Search from "@/components/Search";
import ThemeToggle from "@/components/ThemeToggle";
import MenuButton from "@/components/MenuButton";

export const metadata: Metadata = {
  title: { default: "Chatbase India Docs", template: "%s · Chatbase India Docs" },
  description: "How to use and run Chatbase India: AI support assistants for Indian businesses on websites, WhatsApp and phone calls.",
};

// Applied before the page paints, so a saved light/dark choice doesn't flash.
const THEME = `try{var t=localStorage.getItem("docs-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <a className="skip" href="#content">Skip to content</a>
        <header className="top">
          <MenuButton />
          <Link href="/" className="brand">
            <span className="logo" aria-hidden>
              <svg viewBox="0 0 32 32" width="26" height="26"><rect width="32" height="32" rx="8" fill="var(--accent)" /><path d="M9 9h10a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4h-6l-4 3z" fill="var(--surface)" /></svg>
            </span>
            Chatbase India <span className="muted">Docs</span>
          </Link>
          <Search />
          <nav className="top-links" aria-label="Elsewhere">
            <a href={appUrl}>Open the app</a>
            <a href={site().repo} target="_blank" rel="noopener noreferrer">GitHub</a>
            <ThemeToggle />
          </nav>
        </header>
        <div className="frame">
          <Sidebar sections={nav()} />
          <main id="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
