"use client";

import Link from "next/link";
import { useState } from "react";
import { api, json } from "@/lib/client";

export function ForgotPasswordForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/forgot", { method: "POST", ...json({ email: new FormData(e.currentTarget).get("email") }) });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1>Reset your password</h1>
        {sent ? (
          <p className="ok-text">If an account exists for that e-mail, we&apos;ve sent a link to reset the password. It works for 60 minutes.</p>
        ) : (
          <>
            <p className="muted">Enter your account&apos;s e-mail and we&apos;ll send you a link to choose a new password.</p>
            <label>
              Email
              <input name="email" type="email" required autoComplete="email" />
            </label>
            {error && <p className="error-text">{error}</p>}
            <button className="btn" disabled={busy}>{busy ? "Please wait…" : "Send reset link"}</button>
          </>
        )}
        <p className="muted">
          <Link href="/login">Back to log in</Link>
        </p>
      </form>
    </main>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) return setError("The passwords don't match");
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/reset", { method: "POST", ...json({ token, password: f.get("password") }) });
      window.location.href = "/dashboard";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1>Choose a new password</h1>
        {!token ? (
          <p className="error-text">This reset link is incomplete. Open the link from the e-mail again, or ask for a new one.</p>
        ) : (
          <>
            <label>
              New password
              <input name="password" type="password" required minLength={8} autoComplete="new-password" />
            </label>
            <label>
              Repeat new password
              <input name="confirm" type="password" required minLength={8} autoComplete="new-password" />
            </label>
            <p className="muted small">This signs you out everywhere else.</p>
            {error && <p className="error-text">{error}</p>}
            <button className="btn" disabled={busy}>{busy ? "Please wait…" : "Set new password"}</button>
          </>
        )}
        <p className="muted">
          <Link href="/forgot-password">Ask for a new link</Link>
        </p>
      </form>
    </main>
  );
}
