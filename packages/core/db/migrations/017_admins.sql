-- Platform operators for the admin app (apps/admin). Separate from customer accounts (users).
-- Admins listed in ADMIN_EMAILS sign in with ADMIN_PASSWORD and get a row here on first sign-in (password_hash NULL);
-- admins added from the admin app have their own bcrypt password hash.
CREATE TABLE admins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  name            text NOT NULL DEFAULT '',
  password_hash   text,
  -- Bumped when the password changes or the admin is disabled: older admin sessions stop working.
  session_version integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES admins(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);
