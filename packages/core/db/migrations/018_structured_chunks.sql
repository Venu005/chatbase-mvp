-- Structure-aware chunking: each passage knows its section and PDF page, carries its section (or neighbours) as the
-- context the model reads, and a hash of what was embedded, so re-syncing a source only re-embeds changed passages.
ALTER TABLE chunks
  ADD COLUMN heading_path text NOT NULL DEFAULT '',   -- "Returns › Electronics"
  ADD COLUMN page         integer,
  ADD COLUMN context      text,                      -- NULL for passages made before this: the passage itself is used
  ADD COLUMN content_hash text;
CREATE INDEX chunks_hash_idx ON chunks (source_id, content_hash);

-- Keyword search also matches section headings.
DROP INDEX chunks_tsv_idx;
ALTER TABLE chunks DROP COLUMN tsv;
ALTER TABLE chunks ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(page_title, '') || ' ' || heading_path || ' ' || content)) STORED;
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);

-- Re-syncing: when the source was last read successfully, and a counter that only moves when its passages actually
-- change. The answer cache is invalidated by that counter, so a weekly refresh that changes nothing keeps the cache.
ALTER TABLE sources
  ADD COLUMN content_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN last_synced_at  timestamptz;
UPDATE sources SET last_synced_at = updated_at WHERE status = 'ready';
DROP TRIGGER sources_knowledge ON sources;
CREATE TRIGGER sources_knowledge AFTER INSERT OR DELETE OR UPDATE OF content_version ON sources
  FOR EACH ROW EXECUTE FUNCTION bump_knowledge_version();
