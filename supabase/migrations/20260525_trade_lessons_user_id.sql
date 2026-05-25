-- Add user_id to trade_lessons to match the user_id wiring applied to agent_memory.
-- auto-reflect inserts user_id: trade.user_id ?? null — this column was missing, breaking
-- every lesson write since the 2026-05-24 user_id migration added it to the INSERT call.
ALTER TABLE public.trade_lessons
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trade_lessons_user_id ON public.trade_lessons(user_id);
