-- Executed by scripts/migrate.mjs. {{EMBEDDING_DIM}} is substituted from env.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  plan          text NOT NULL DEFAULT 'free',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  instructions    text NOT NULL DEFAULT '',
  welcome_message text NOT NULL DEFAULT 'Hi! How can I help you today?',
  brand_color     text NOT NULL DEFAULT '#4f46e5',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_user_idx ON agents(user_id);

CREATE TABLE sources (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('url','file','text')),
  title      text NOT NULL,
  url        text,
  status     text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','failed')),
  error      text,
  char_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_agent_idx ON sources(agent_id);

-- Retrieval is an exact (non-approximate) cosine search filtered by agent_id.
-- That is correct and fast for typical per-agent corpora (up to ~100k chunks).
-- For very large corpora add an HNSW index and enable pgvector iterative scans
-- (pgvector >= 0.8), otherwise filtered ANN queries can under-return results.
CREATE TABLE chunks (
  id         bigserial PRIMARY KEY,
  source_id  uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  page_title text NOT NULL DEFAULT '',
  page_url   text,
  content    text NOT NULL,
  embedding  vector({{EMBEDDING_DIM}}) NOT NULL
);
CREATE INDEX chunks_agent_idx ON chunks(agent_id);
CREATE INDEX chunks_source_idx ON chunks(source_id);

CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  channel    text NOT NULL DEFAULT 'widget',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, session_id)
);
CREATE INDEX conversations_agent_idx ON conversations(agent_id, updated_at DESC);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         text NOT NULL,
  citations       jsonb NOT NULL DEFAULT '[]',
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages(conversation_id, id);

-- Monthly message-credit counter per account (atomic limit enforcement).
CREATE TABLE usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period  text NOT NULL,          -- 'YYYY-MM' (UTC)
  used    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
