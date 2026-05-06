-- Add trace_id to trades so Langfuse generations can be scored post-settle.
-- Nullable — rows created before this migration have no trace and are silently skipped by auto-settle scoring.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS trace_id TEXT;
