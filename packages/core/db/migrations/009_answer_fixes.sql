-- Q&A pairs written by the owner ("Fix this answer" in the inbox, or the Q&A tab). A visitor question that is
-- close in meaning to a fix's question gets the owner's answer, ahead of everything in the knowledge sources.
CREATE TABLE answer_fixes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  question   text NOT NULL,
  answer     text NOT NULL,
  embedding  vector({{EMBEDDING_DIM}}) NOT NULL,   -- of the question
  message_id bigint REFERENCES messages(id) ON DELETE SET NULL,  -- the bot answer this corrected, if any
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX answer_fixes_agent_idx ON answer_fixes (agent_id, created_at DESC);
