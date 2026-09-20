-- Human handoff: a conversation can be taken over by the business owner.
--   mode = 'bot'    the AI answers (default)
--   mode = 'human'  the AI stays silent; the owner replies from the dashboard
--   needs_reply     true from the moment the visitor asks for a person (or writes again) until the owner replies
ALTER TABLE agents
  ADD COLUMN handoff_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN handoff_message text    NOT NULL DEFAULT 'I have asked a member of our team to help you. They will reply here as soon as they can.',
  ADD COLUMN notify_email    boolean NOT NULL DEFAULT true;

ALTER TABLE conversations
  ADD COLUMN mode             text    NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot','human')),
  ADD COLUMN needs_reply      boolean NOT NULL DEFAULT false,
  ADD COLUMN needs_reply_at   timestamptz,   -- when needs_reply last turned true (drives auto-resume of the bot)
  ADD COLUMN handoff_reason   text,
  ADD COLUMN handoff_at       timestamptz,
  ADD COLUMN visitor_contact  text,
  ADD COLUMN last_notified_at timestamptz;

CREATE INDEX conversations_needs_reply_idx ON conversations (agent_id) WHERE needs_reply;

-- Messages typed by the business owner.
ALTER TABLE messages DROP CONSTRAINT messages_role_check;
ALTER TABLE messages ADD CONSTRAINT messages_role_check CHECK (role IN ('user','assistant','human'));
