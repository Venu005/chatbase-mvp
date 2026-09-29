-- One row per AI call: every bot answer (or failed attempt) and every ingestion embedding job. Powers cost tracking,
-- the admin view and answer traces ("why did the bot say that?").
CREATE TABLE ai_calls (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,     -- kept for the account's totals if the agent is deleted
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      bigint REFERENCES messages(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('answer', 'ingest')),
  channel         text,
  provider        text NOT NULL DEFAULT '',
  model           text NOT NULL DEFAULT '',
  prompt_version  text,
  status          text NOT NULL CHECK (status IN ('ok', 'partial', 'error')),
  error           text,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  tokens_estimated boolean NOT NULL DEFAULT false,
  cost_usd        numeric(12, 6),                                    -- NULL when no price is configured for the model
  first_token_ms  integer,
  total_ms        integer,
  attempts        integer NOT NULL DEFAULT 1,
  fallback_used   boolean NOT NULL DEFAULT false,
  question        text,                                              -- the visitor's message (first 1,000 characters)
  retrieved       jsonb NOT NULL DEFAULT '[]',                       -- [{chunkId, score, title, url}]
  fixes           jsonb NOT NULL DEFAULT '[]',                       -- [{id, score, question}] Q&A answers that matched
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_created_idx ON ai_calls (created_at DESC);
CREATE INDEX ai_calls_user_idx ON ai_calls (user_id, created_at DESC);
CREATE INDEX ai_calls_agent_idx ON ai_calls (agent_id, created_at DESC);
CREATE INDEX ai_calls_problems_idx ON ai_calls (created_at DESC) WHERE status <> 'ok' OR fallback_used;
CREATE INDEX ai_calls_message_idx ON ai_calls (message_id) WHERE message_id IS NOT NULL;
