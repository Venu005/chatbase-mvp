-- Durable ingestion: a source in status 'processing' is a job. Workers claim it with a lease (locked_until), so a
-- crashed server's job is picked up again, and transient failures are retried with backoff (attempts, run_after).
ALTER TABLE sources
  ADD COLUMN attempts     integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN run_after    timestamptz NOT NULL DEFAULT now();
CREATE INDEX sources_jobs_idx ON sources (run_after) WHERE status = 'processing';

-- What a source was made from, so it can be processed later, retried, or re-indexed with another embedding model.
-- Uploaded files are kept until their text has been extracted; after that only the extracted text is kept.
CREATE TABLE source_payloads (
  source_id uuid PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  docs      jsonb,        -- [{title, url, text}] once known (pasted text, or extracted from a file)
  file      bytea,        -- uploaded file, until its text is extracted
  file_ext  text
);

-- Which embedding model made each vector. Vectors from different models can't be compared, so search only uses
-- the current model's (NULL = made before this was tracked, assumed current). The admin view can re-index the rest.
ALTER TABLE chunks ADD COLUMN embedding_model text;
ALTER TABLE answer_fixes ADD COLUMN embedding_model text;
