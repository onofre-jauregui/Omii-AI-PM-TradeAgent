-- ═══════════════════════════════════════════════════════════════════════════
-- Real-money trading foundation — schema integrity (W1)
--
-- APPLY VIA THE MANAGEMENT API (never `supabase db push` — history is out of sync):
--   source ~/.omii_env && curl -s -X POST \
--     "https://api.supabase.com/v1/projects/uyfnezxmgwitpzsrnkst/database/query" \
--     -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_KTA" \
--     -H "Content-Type: application/json" \
--     --data-binary @- < supabase/migrations/20260719_realmoney_foundation.sql
--   (or paste the SQL as the {"query": "..."} body)
--
-- Every statement is idempotent. The only DELETE is a de-dup safety net that
-- keeps the most-recent row per (user_id, date); review before applying.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. trades.status — allow 'settled' ───────────────────────────────────────
-- auto-settle writes status='settled', but the constraint in migration history
-- omits it (the live DB drifted). Recreate the constraint with the full set so
-- live settlement is valid and the schema matches reality.
ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_status_check;
ALTER TABLE public.trades ADD CONSTRAINT trades_status_check
  CHECK (status IN ('pending', 'open', 'filled', 'partial', 'settled', 'failed', 'cancelled', 'expired'));

-- ── 2. risk_settings.max_daily_trades — add the missing column ────────────────
-- Onboarding (OnboardingPage.tsx) and RiskControlsPanel write max_daily_trades,
-- but no migration ever added it — those writes were failing silently.
ALTER TABLE public.risk_settings
  ADD COLUMN IF NOT EXISTS max_daily_trades INTEGER NOT NULL DEFAULT 30;

-- ── 3. risk_state — real UNIQUE(user_id, date) so upserts work ────────────────
-- The current uniqueness is a FUNCTIONAL index on (COALESCE(user_id,''), date),
-- which PostgREST's column-based onConflict cannot target — so the kill switch
-- and the server-side auto-halt upserts silently fail. Replace it with a plain
-- unique constraint on (user_id, date).
--
-- Safety de-dup (keeps the most-recently-updated row per user+date). The
-- functional index should already prevent duplicates, so this is a no-op in
-- practice; included so the ADD CONSTRAINT below can never fail on legacy data.
DELETE FROM public.risk_state a
  USING public.risk_state b
  WHERE a.ctid < b.ctid
    AND a.user_id IS NOT DISTINCT FROM b.user_id
    AND a.date = b.date;

DROP INDEX IF EXISTS public.risk_state_user_date_unique;
ALTER TABLE public.risk_state DROP CONSTRAINT IF EXISTS risk_state_user_date_unique;
ALTER TABLE public.risk_state DROP CONSTRAINT IF EXISTS risk_state_user_date_key;
ALTER TABLE public.risk_state ADD CONSTRAINT risk_state_user_date_key UNIQUE (user_id, date);

-- ── 4. Seed default risk_settings for every user (close the no-limits hole) ───
-- evaluateRisk treats a missing risk_settings row as "no limits". execute-trade
-- now fail-closes live over that, but the proper fix is that NO user is ever in
-- the unbounded state. Seed conservative defaults on signup + backfill existing
-- users who never completed onboarding. Onboarding/RiskControlsPanel overwrite
-- these with the user's chosen values later.
--
-- Both inserts below conflict-target nothing on purpose. They were written when
-- risk_settings had a UNIQUE on (user_id) alone; 20260723_risk_settings_mode_scoping
-- and 20260807_risk_settings_dedupe_and_constraint_reconcile later replaced it with
-- UNIQUE (user_id, mode), which leaves a bare `ON CONFLICT (user_id)` here with no
-- constraint to infer — `42P10: there is no unique or exclusion constraint matching
-- the ON CONFLICT specification`. Migrations replay, so an old one has to stay valid
-- against the schema its successors leave behind. Omitting the inference is
-- constraint-agnostic and keeps the intent exactly: seed, never overwrite.
CREATE OR REPLACE FUNCTION public.seed_risk_settings_for_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.risk_settings (
    user_id, max_position_size, max_open_positions, max_daily_loss,
    max_drawdown_pct, allocated_capital, max_daily_trades
  )
  VALUES (NEW.id::text, 20, 3, 100, 10, 500, 30)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_seed_risk ON auth.users;
CREATE TRIGGER on_auth_user_created_seed_risk
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.seed_risk_settings_for_new_user();

-- Backfill existing users with no risk_settings row.
INSERT INTO public.risk_settings (
  user_id, max_position_size, max_open_positions, max_daily_loss,
  max_drawdown_pct, allocated_capital, max_daily_trades
)
SELECT u.id::text, 20, 3, 100, 10, 500, 30
FROM auth.users u
LEFT JOIN public.risk_settings r ON r.user_id = u.id::text
WHERE r.user_id IS NULL
ON CONFLICT DO NOTHING;
