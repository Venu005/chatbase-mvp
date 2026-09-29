-- True on a bot answer when nothing in the knowledge sources (or Q&A answers) matched the question:
-- the Analytics tab lists these as "knowledge gaps" so the owner can add the missing information.
ALTER TABLE messages ADD COLUMN knowledge_gap boolean NOT NULL DEFAULT false;
CREATE INDEX messages_gap_idx ON messages (conversation_id) WHERE knowledge_gap;
