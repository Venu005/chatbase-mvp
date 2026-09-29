"use client";

import { useCallback, useEffect, useState } from "react";
import { api, json } from "@chatbase/core/client";

// Mirrors GET /api/admin/admins.
type AdminRow = {
  id: string | null;
  email: string;
  name: string;
  has_password: boolean;
  created_at: string | null;
  last_login_at: string | null;
  created_by: string | null;
  fromEnv: boolean;
  you: boolean;
};

const when = (d: string | null) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "never");

export default function Admins() {
  const [admins, setAdmins] = useState<AdminRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setAdmins((await api<{ admins: AdminRow[] }>("/api/admin/admins")).admins);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/admin/admins", { method: "POST", ...json({ email: f.get("email"), name: f.get("name"), password: f.get("password") }) });
      form.reset();
      setNotice(`Added ${f.get("email")}. Share the password with them privately; they can change it after signing in.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: AdminRow) {
    if (!a.id || !confirm(`Remove ${a.email} as an admin? They are signed out at once.`)) return;
    setError("");
    setNotice("");
    try {
      await api(`/api/admin/admins/${a.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError("");
    setNotice("");
    try {
      await api("/api/admin/me/password", { method: "POST", ...json({ currentPassword: f.get("current"), newPassword: f.get("next") }) });
      form.reset();
      setNotice("Password changed. Your other sessions were signed out.");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="stack">
      <p className="muted">
        People who can open this admin app. Admins listed in <code>ADMIN_EMAILS</code> sign in with <code>ADMIN_PASSWORD</code> and are managed
        in the environment; everyone added here has their own password.
      </p>
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
      <div className="card table-wrap">
        <table className="data-table admin-table">
          <thead>
            <tr>
              <th>Admin</th>
              <th>Sign-in</th>
              <th>Added</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {admins === null && (
              <tr>
                <td colSpan={5} className="muted">Loading…</td>
              </tr>
            )}
            {admins?.map((a) => (
              <tr key={a.id ?? a.email}>
                <td>
                  {a.email} {a.you && <span className="badge team">you</span>}
                  {a.name && <div className="muted small">{a.name}</div>}
                </td>
                <td className="small">{a.fromEnv ? (a.has_password ? "ADMIN_PASSWORD or own password" : "ADMIN_PASSWORD") : "Own password"}</td>
                <td className="small nowrap">
                  {a.fromEnv && !a.created_by ? "ADMIN_EMAILS" : when(a.created_at)}
                  {a.created_by && <div className="muted">by {a.created_by}</div>}
                </td>
                <td className="small nowrap">{when(a.last_login_at)}</td>
                <td>
                  {a.id && !a.you && !a.fromEnv && (
                    <button className="btn danger" onClick={() => remove(a)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card stack" onSubmit={add}>
        <h3>Add an admin</h3>
        <label>
          Email
          <input name="email" type="email" required autoComplete="off" />
        </label>
        <label>
          Name (optional)
          <input name="name" autoComplete="off" />
        </label>
        <label>
          Password (12+ characters)
          <input name="password" type="password" required minLength={12} autoComplete="new-password" />
        </label>
        <button className="btn" disabled={busy}>
          {busy ? "Adding…" : "Add admin"}
        </button>
      </form>
      <form className="card stack" onSubmit={changePassword}>
        <h3>Change your password</h3>
        <label>
          Current password
          <input name="current" type="password" required autoComplete="current-password" />
        </label>
        <label>
          New password (12+ characters)
          <input name="next" type="password" required minLength={12} autoComplete="new-password" />
        </label>
        <button className="btn ghost">Change password</button>
      </form>
    </section>
  );
}
