"use client";

import Link from "next/link";
import { useState } from "react";
import { api, json } from "@/lib/client";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await api(`/api/auth/${mode}`, {
        method: "POST",
        ...json({ email: f.get("email"), password: f.get("password"), ...(signup ? { name: f.get("name") } : {}) }),
      });
      window.location.href = "/dashboard";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1>{signup ? "Create your account" : "Welcome back"}</h1>
        {signup && (
          <label>
            Name
            <input name="name" autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" type="password" required minLength={signup ? 8 : 1} autoComplete={signup ? "new-password" : "current-password"} />
        </label>
        {!signup && (
          <Link href="/forgot-password" className="small">
            Forgot password?
          </Link>
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="btn" disabled={busy}>
          {busy ? "Please wait…" : signup ? "Sign up" : "Log in"}
        </button>
        <p className="muted">
          {signup ? (
            <>
              Already have an account? <Link href="/login">Log in</Link>
            </>
          ) : (
            <>
              New here? <Link href="/signup">Create an account</Link>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
