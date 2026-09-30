-- Admin insights and actions: bonus credits, admin-granted (comped) plans, an audit log of admin actions, and a record
-- of operational alerts already e-mailed (so each alert is sent at most once per cooldown).

-- Extra credits an admin granted for that month, on top of the plan's.
ALTER TABLE usage ADD COLUMN bonus integer NOT NULL DEFAULT 0;

-- True when an admin set the plan by hand (a trial, a partner, a refund): such accounts aren't counted as revenue.
ALTER TABLE users ADD COLUMN plan_comped boolean NOT NULL DEFAULT false;

CREATE TABLE admin_audit (
  id             bigserial PRIMARY KEY,
  admin_id       uuid REFERENCES admins(id) ON DELETE SET NULL,
  admin_email    text NOT NULL,                                   -- kept when the admin is removed
  action         text NOT NULL,                                   -- 'plan.change', 'credits.grant', 'account.view_conversations', ...
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_email   text,
  details        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit (created_at DESC);
CREATE INDEX admin_audit_target_idx ON admin_audit (target_user_id, created_at DESC);

CREATE TABLE ops_alerts (
  key          text PRIMARY KEY,                                  -- 'answer_errors', 'slow_answers', ...
  last_sent_at timestamptz NOT NULL,
  last_message text NOT NULL
);

-- Busy-hour and cohort queries scan conversations and answers by time.
CREATE INDEX IF NOT EXISTS conversations_created_idx ON conversations (created_at DESC);
CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at DESC);
