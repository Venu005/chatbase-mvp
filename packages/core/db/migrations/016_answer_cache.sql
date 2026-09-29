-- Answer cache for repeated first questions ("What are your timings?"). An agent's knowledge_version changes whenever
-- anything that shapes its answers changes, so cached answers can never be stale: they are keyed by it.
ALTER TABLE agents ADD COLUMN knowledge_version bigint NOT NULL DEFAULT 0;

CREATE FUNCTION bump_knowledge_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agents SET knowledge_version = knowledge_version + 1 WHERE id = COALESCE(NEW.agent_id, OLD.agent_id);
  RETURN NULL;
END $$;

-- A source finished (or stopped) indexing, or was removed.
CREATE TRIGGER sources_knowledge AFTER INSERT OR DELETE OR UPDATE OF status, chunk_count ON sources
  FOR EACH ROW EXECUTE FUNCTION bump_knowledge_version();
-- A Q&A answer was added, edited or removed.
CREATE TRIGGER answer_fixes_knowledge AFTER INSERT OR UPDATE OR DELETE ON answer_fixes
  FOR EACH ROW EXECUTE FUNCTION bump_knowledge_version();

-- The agent's own settings that go into the prompt.
CREATE FUNCTION bump_agent_knowledge_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.instructions IS DISTINCT FROM OLD.instructions
     OR NEW.handoff_enabled IS DISTINCT FROM OLD.handoff_enabled THEN
    NEW.knowledge_version := OLD.knowledge_version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agents_knowledge BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION bump_agent_knowledge_version();

CREATE TABLE answer_cache (
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  question_key      text NOT NULL,       -- normalised question (see src/lib/cache-key.ts)
  knowledge_version bigint NOT NULL,
  prompt_version    text NOT NULL,
  model             text NOT NULL,
  answer            text NOT NULL,
  citations         jsonb NOT NULL DEFAULT '[]',
  knowledge_gap     boolean NOT NULL DEFAULT false,
  hits              integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, question_key)
);
