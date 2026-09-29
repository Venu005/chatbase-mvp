-- What retrieval actually searched for (the visitor's message, plus context for follow-ups, or a rewritten query),
-- and the cost of rewriting it (QUERY_REWRITE=on). Shown in the admin answer trace.
ALTER TABLE ai_calls
  ADD COLUMN search_query   text,
  ADD COLUMN rewrite_model  text,
  ADD COLUMN rewrite_tokens integer NOT NULL DEFAULT 0;
