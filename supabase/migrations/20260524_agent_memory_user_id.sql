-- Index for per-user memory queries (hot path: trading-agent system prompt injection)
CREATE INDEX IF NOT EXISTS idx_agent_memory_user_id
  ON public.agent_memory (user_id)
  WHERE user_id IS NOT NULL;

-- Update RLS: users see their own memories + platform memories (user_id IS NULL)
DROP POLICY IF EXISTS "Users can manage own memories" ON public.agent_memory;
CREATE POLICY "Users can manage own memories" ON public.agent_memory
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text);

-- Backfill: assign existing memories to the sole current user
-- (system is single-user in practice; NULL-user memories become user-scoped)
UPDATE public.agent_memory
  SET user_id = (SELECT id::text FROM auth.users ORDER BY created_at LIMIT 1)
  WHERE user_id IS NULL;
