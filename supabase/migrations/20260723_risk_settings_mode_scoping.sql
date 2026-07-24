-- Risk-settings mode scoping — reconcile committed schema with production drift.
--
-- Background: `risk_settings.mode` and the unique index
-- `risk_settings_user_mode_idx UNIQUE (user_id, mode)` were added directly to
-- production via the Management API and never captured in a migration. Committed
-- migrations (e.g. 20260610_risk_settings_unique_user.sql) still teach a
-- one-row-per-user model, and the generated types were never refreshed — so
-- nothing at compile time, in migration history, or in CI could catch the code
-- that queried risk_settings by user_id alone. That gap is what let the
-- live-trade-rejection bug exist (a user_id-only `.maybeSingle()` now matches
-- both the paper and live rows and errors).
--
-- This migration makes a DB rebuilt from migrations (fresh staging, CI shadow,
-- DR clone) match production, and fixes the WRITE path (seed trigger) so the
-- one-row-per-(user_id, mode) invariant the code depends on actually holds for
-- the next signup. Every statement is idempotent — safe to apply to the already-
-- drifted production DB (where the column and index already exist).

-- 1. Ensure the mode column exists (already present in prod).
ALTER TABLE public.risk_settings
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'paper';

-- 2. Drop any stale (user_id)-alone uniqueness — it is superseded by (user_id, mode).
--    Both the named constraint (from 20260610) and any equivalently-named index.
ALTER TABLE public.risk_settings
  DROP CONSTRAINT IF EXISTS risk_settings_user_id_unique;
DROP INDEX IF EXISTS public.risk_settings_user_id_unique;

-- 3. Ensure the real uniqueness the code relies on: one row per (user_id, mode).
CREATE UNIQUE INDEX IF NOT EXISTS risk_settings_user_mode_idx
  ON public.risk_settings (user_id, mode);

-- 4. Backfill: every user must have BOTH a paper and a live row. Idempotent via
--    the unique index above. Copies existing per-user values into the missing
--    mode so a user who already tuned their paper limits doesn't get defaults.
INSERT INTO public.risk_settings (
  user_id, mode, max_position_size, max_open_positions, max_daily_loss,
  max_drawdown_pct, allocated_capital, max_daily_trades, auto_stop_loss,
  stop_loss_pct, default_order_type
)
SELECT
  src.user_id, want.mode, src.max_position_size, src.max_open_positions,
  src.max_daily_loss, src.max_drawdown_pct, src.allocated_capital,
  src.max_daily_trades, src.auto_stop_loss, src.stop_loss_pct, src.default_order_type
FROM (
  SELECT DISTINCT ON (user_id) *
  FROM public.risk_settings
  ORDER BY user_id, updated_at DESC
) src
CROSS JOIN (VALUES ('paper'), ('live')) AS want(mode)
ON CONFLICT (user_id, mode) DO NOTHING;

-- 5. Fix the WRITE path: the new-user seed trigger must create BOTH rows and
--    target the real (user_id, mode) arbiter. The prior body used
--    `ON CONFLICT (user_id)`, which matches no unique index post-drift and would
--    raise 42P10 on the next signup — rolling back the auth.users INSERT.
CREATE OR REPLACE FUNCTION public.seed_risk_settings_for_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.risk_settings (
    user_id, mode, max_position_size, max_open_positions, max_daily_loss,
    max_drawdown_pct, allocated_capital, max_daily_trades
  )
  VALUES
    (NEW.id::text, 'paper', 20, 3, 100, 10, 500, 30),
    (NEW.id::text, 'live',  20, 3, 100, 10, 500, 30)
  ON CONFLICT (user_id, mode) DO NOTHING;
  RETURN NEW;
END;
$$;
