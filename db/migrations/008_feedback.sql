-- Visitor ratings of bot answers in the website widget: 1 = helpful, -1 = not helpful, NULL = not rated.
ALTER TABLE messages
  ADD COLUMN feedback    smallint CHECK (feedback IN (-1, 1)),
  ADD COLUMN feedback_at timestamptz;
CREATE INDEX messages_feedback_idx ON messages (conversation_id) WHERE feedback IS NOT NULL;
