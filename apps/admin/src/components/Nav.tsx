"use client";

import Link from "next/link";
import { api } from "@chatbase/core/client";

export default function Nav({ email }: { email: string }) {
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
        <span className="muted">{email}</span>
        <button className="link-btn" onClick={logout}>
          Log out
        </button>
      </div>
    </header>
  );
}
