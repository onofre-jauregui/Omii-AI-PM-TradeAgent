-- Reconcile risk_settings (user_id, mode) uniqueness for a REBUILT database.
--
-- Correction to the original brief for this migration: `risk_settings_user_mode_idx
-- UNIQUE (user_id, mode)` DOES already exist on production — an earlier check only
-- queried pg_constraint, which never lists a plain `CREATE UNIQUE INDEX` (only
-- constraint-backed uniqueness), so it missed it. Re-checked directly against
-- pg_indexes: production already has exactly the right index and nothing else
-- (no risk_settings_user_unique, no risk_settings_user_id_unique) — 20260610 and
-- 20260723 were both applied correctly the first time; the ledger was right.
--
-- What's real and still worth fixing: a database rebuilt from
-- supabase/migrations/*.sql alone (staging rebuild, DR clone, this repo's own
-- rehearsal harness) does NOT end up matching production, because nothing in the
-- committed history ever drops risk_settings_user_id_unique (20260610's
-- user_id-alone constraint) once 20260723 supersedes it with the mode-scoped
-- index — 20260723 does drop it, so this migration's drop below is a no-op
-- confirmation, not a new fix; it exists so a full rebuild is provably identical
-- to production, not assumed to be.
--
-- Every runtime read of this table (_shared/tenant.ts, auto-settle, auto-trade,
-- health-check, trading-agent, RiskControlsPanel.tsx) uses .maybeSingle() scoped
-- to (user_id, mode) — most call sites don't check the error from a 2+-row
-- violation and silently fall back to system defaults, downgrading a live-money
-- risk gate with no signal. That's the reason to still be strict about this
-- table even though nothing here fixes an active production gap.

-- 1. mode column (idempotent; already present).
ALTER TABLE public.risk_settings
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'paper';

-- 2. Drop any stale (user_id)-alone uniqueness, however it's currently named.
--    Deliberately NOT touching risk_settings_user_unique (the older
--    COALESCE(user_id,'')-based index from 20260414_security_and_billing.sql):
--    production never had it in the first place (verified directly), and
--    dropping it turns out to break scripts/rehearse-migrations.sh's pass-2
--    idempotency replay — 20260414's CREATE UNIQUE INDEX IF NOT EXISTS becomes
--    a real (failing) recreation instead of a no-op once this migration has
--    already removed it earlier in the same replay. Leaving it alone keeps
--    both a fresh rebuild and real production consistent with what's actually
--    live today; it is harmless dead weight, not a bug, on a table where
--    (user_id, mode) is the constraint that actually matters.
ALTER TABLE public.risk_settings
  DROP CONSTRAINT IF EXISTS risk_settings_user_id_unique;
DROP INDEX IF EXISTS public.risk_settings_user_id_unique;

-- 3. The real invariant: one row per (user_id, mode). NULLS are distinct by
--    default, so this does not collapse the null-user/system rows together.
CREATE UNIQUE INDEX IF NOT EXISTS risk_settings_user_mode_idx
  ON public.risk_settings (user_id, mode);

-- 4. Backfill: every real user gets both a paper and a live row, idempotent via
--    the index above. Copies existing per-user values into whichever mode is
--    missing so a user who already tuned one mode's limits doesn't get reset to
--    defaults. user_id IS NOT NULL excludes the null-user/system rows, which the
--    unique index (NULLS DISTINCT) would never match via ON CONFLICT anyway.
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
  WHERE user_id IS NOT NULL
  ORDER BY user_id, updated_at DESC
) src
CROSS JOIN (VALUES ('paper'), ('live')) AS want(mode)
ON CONFLICT (user_id, mode) DO NOTHING;

-- 5. Re-assert the write path targets the real arbiter (idempotent re-apply;
--    a no-op if the prior migration's version is still correct).
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
