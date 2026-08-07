-- Capture six columns that existed only in the production database.
--
-- The companion to 20260316000000: that file captured whole tables the migration
-- set never created, this one captures columns added to tables it does create.
-- Found by diffing the production catalogue against a database rebuilt from
-- supabase/migrations/ alone — 477 production columns against 487 rebuilt, with
-- these six present in production and absent from the rebuild.
--
-- `trades.user_rating` is the one that broke the replay outright:
-- 20260717_trades_user_rating_idx.sql indexes a column no migration ever added.
-- The rest were silent — a database rebuilt from git would have come up missing
-- the basket tenant key, the compliance-log category the event allowlist keys
-- off, the strategy scheduling fields, and the waitlist plan interest.
--
-- Every statement is ADD COLUMN IF NOT EXISTS, so applying this to production is
-- a verified no-op. Sorted immediately after the table captures and before every
-- migration that reads these columns.
--
-- Read from production project uyfnezxmgwitpzsrnkst on 2026-08-06.

-- Tenant key for baskets. TEXT to match trades.user_id and strategies.user_id,
-- which is the convention across this schema.
ALTER TABLE public.baskets
  ADD COLUMN IF NOT EXISTS user_id TEXT;

-- Splits compliance_log into regulated ('compliance') and operational ('ops')
-- rows. Load-bearing: compliance_event_type_allowlist keys its whole allowlist
-- off `category <> 'compliance'`, so without this column the constraint cannot
-- be created and every event type would be accepted as compliance-grade.
ALTER TABLE public.compliance_log
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'ops';

-- Per-strategy scheduling, read by auto-trade to decide whether a strategy is
-- due. Missing these, a rebuilt database would run every strategy every cycle.
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS run_interval_minutes INTEGER;

-- Thumbs up/down from TradeLog.tsx, and the input to the user_feedback memories
-- the agent learns from.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS user_rating TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trades_user_rating_check'
      AND conrelid = 'public.trades'::regclass
  ) THEN
    ALTER TABLE public.trades
      ADD CONSTRAINT trades_user_rating_check CHECK (user_rating = ANY (ARRAY['good'::text, 'bad'::text]));
  END IF;
END
$$;

-- Which plan a waitlist signup expressed interest in.
ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS plan_interest TEXT;

-- ── Indexes that existed only in production ────────────────────────────────
-- Same story as the columns above: added through the dashboard and never
-- written down, so a database rebuilt from git came up without them. Two of
-- them are the ones the hot read paths depend on — the composite on trades
-- backs every per-user dashboard query, and the partial index backs the
-- unsettled-paper-position scan auto-settle runs every ten minutes.
CREATE INDEX IF NOT EXISTS idx_baskets_user_id
  ON public.baskets USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_compliance_log_severity_created_at
  ON public.compliance_log USING btree (severity, created_at);

CREATE INDEX IF NOT EXISTS idx_trades_user_mode_status_settled
  ON public.trades USING btree (user_id, mode, status, settled_at);

CREATE INDEX IF NOT EXISTS trades_unsettled_idx
  ON public.trades USING btree (mode, status, settled_at)
  WHERE ((mode = 'paper'::text) AND (status = 'filled'::text) AND (settled_at IS NULL));

-- Dedupes signal generation per (ticker, source). Production has enforced this
-- since the dashboard era; without it a rebuilt database would accept duplicate
-- signals for the same market from the same generator.
CREATE UNIQUE INDEX IF NOT EXISTS signals_ticker_source_unique
  ON public.signals USING btree (ticker, source);
