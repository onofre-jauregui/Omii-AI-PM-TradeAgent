-- Add summary field for compact system prompt injection
-- and merged_into for tracking compaction chains
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES agent_memory(id);
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS token_estimate INTEGER DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS child_count INTEGER DEFAULT 0;

-- Index for finding uncompacted memories
CREATE INDEX IF NOT EXISTS idx_agent_memory_needs_summary
  ON agent_memory (is_active, summary)
  WHERE is_active = true AND summary IS NULL;
