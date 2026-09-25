-- Allowed websites for an agent's chat widget (empty = any website). See src/lib/domains.ts.
ALTER TABLE agents ADD COLUMN allowed_domains text[] NOT NULL DEFAULT '{}';

-- Bumped whenever the password changes: session tokens carry it, so older sessions stop working.
ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0;

-- Single-use password reset links. Only a SHA-256 hash of the token is stored.
CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);
