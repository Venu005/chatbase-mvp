-- WhatsApp Cloud API channel: one WhatsApp number per agent.
-- Secrets (access token, app secret) are stored encrypted (AES-256-GCM, see src/lib/crypto.ts).
CREATE TABLE whatsapp_channels (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             uuid NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  phone_number_id      text NOT NULL UNIQUE,
  display_phone_number text NOT NULL DEFAULT '',
  verified_name        text NOT NULL DEFAULT '',
  access_token_enc     text NOT NULL,
  app_secret_enc       text NOT NULL,
  verify_token         text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_message_at      timestamptz
);

-- Meta delivers webhooks at-least-once; this table makes processing idempotent.
CREATE TABLE whatsapp_events (
  wamid       text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_events_received_idx ON whatsapp_events (received_at);
