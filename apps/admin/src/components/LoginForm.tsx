"use client";

import { useState } from "react";
import { api, json } from "@chatbase/core/client";

export default function LoginForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await api("/api/auth/login", { method: "POST", ...json({ email: f.get("email"), password: f.get("password") }) });
      window.location.href = "/";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1>Admin sign-in</h1>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn" disabled={busy}>
          {busy ? "Please wait…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
