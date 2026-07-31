-- P1: mode-scope risk_state (the deferred "PR6").
--
-- risk_state was mode-BLIND: one row per (user_id, date) accumulated paper and
-- live P&L/trade-counts together. Consequences measured in production:
--   - 9 paper positions blocked live trading ("max open positions reached"
--     with 0 live positions) — patched around in execute-trade at the time.
--   - A daily-loss halt triggered by paper losses stops LIVE trading (and
--     vice versa), which also poisons the promotion ladder's demotion trigger.
--
-- Historical rows are labeled 'paper': they contain mixed paper+live activity
-- from the mode-blind era and paper was ~95% of volume. The 'live' history
-- effectively restarts clean from this migration — preferable to pretending
-- mixed rows are clean live history.

ALTER TABLE public.risk_state
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'paper'
  CHECK (mode IN ('paper', 'live'));

-- Uniqueness becomes (user_id, date, mode).
ALTER TABLE public.risk_state DROP CONSTRAINT IF EXISTS risk_state_user_date_key;
DROP INDEX IF EXISTS risk_state_user_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS risk_state_user_date_mode_key
  ON public.risk_state (user_id, date, mode);
