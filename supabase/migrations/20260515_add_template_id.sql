-- Add template_id so auto-trade can route on strategy type regardless of the PK.
-- System strategies get template_id = id (backfill). User strategies get template_id
-- set during onboarding so routing works for both system and per-user strategy rows.
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS template_id TEXT;

UPDATE public.strategies
  SET template_id = id
  WHERE user_id IS NULL AND template_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_strategies_template_id
  ON public.strategies (template_id);
