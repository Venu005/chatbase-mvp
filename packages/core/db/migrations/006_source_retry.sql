-- Lets a failed website source be retried with its original settings, and lets the app notice sources whose
-- background ingestion was lost (server restart or crash while they were "processing").
ALTER TABLE sources
  ADD COLUMN crawl_pages integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();
