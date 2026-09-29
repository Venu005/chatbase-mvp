-- Lead capture: the widget can ask visitors for their details (before the chat, or after the first answer).
-- WhatsApp numbers and contact details left during a handoff are saved as leads too.
ALTER TABLE agents
  ADD COLUMN lead_mode    text   NOT NULL DEFAULT 'off' CHECK (lead_mode IN ('off', 'after_first_answer', 'before_chat')),
  ADD COLUMN lead_fields  text[] NOT NULL DEFAULT '{name,phone}',
  ADD COLUMN lead_message text   NOT NULL DEFAULT 'Share your details so our team can get back to you.';

CREATE TABLE leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id text NOT NULL,                     -- same id as conversations.session_id (joins the chat)
  channel    text NOT NULL DEFAULT 'widget',
  source     text NOT NULL DEFAULT 'form' CHECK (source IN ('form', 'handoff', 'whatsapp')),
  name       text,
  email      text,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, session_id)
);
CREATE INDEX leads_agent_idx ON leads (agent_id, created_at DESC);
