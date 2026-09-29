-- Keyword search next to vector search (hybrid retrieval). 'simple' = no language-specific stemming or stopwords, so it
-- works the same for English, Hindi (Devanagari), Hinglish and product codes like AM-B500. The page title is included.
ALTER TABLE chunks ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(page_title, '') || ' ' || content)) STORED;
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
