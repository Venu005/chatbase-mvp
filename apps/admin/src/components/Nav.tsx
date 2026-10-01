"use client";

import Link from "next/link";
import { api } from "@chatbase/core/client";

export default function Nav({ email, docsUrl }: { email: string; docsUrl: string }) {
  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }
  return (
    <header className="nav">
      <Link href="/" className="brand">
        Chatbase India admin
      </Link>
      <div className="nav-right">
        <a href={`${docsUrl}/admin`} target="_blank" rel="noopener">Help</a>
        <span className="muted">{email}</span>
        <button className="link-btn" onClick={logout}>
          Log out
        </button>
      </div>
    </header>
  );
}
