-- Capture the five tables that existed only in the production database.
--
-- These were created through the Lovable/Supabase dashboard and never written
-- into a migration, so `supabase/migrations/` could not rebuild the schema:
-- production had 35 public base tables while the migration set created 30. A
-- replay into an empty database therefore failed the moment anything referenced
-- them — `profiles` alone is read by eight later migrations, including the five
-- admin RLS policies in 20260520_admin_rls_bypass.sql.
--
-- Read verbatim from the production catalogue of uyfnezxmgwitpzsrnkst on
-- 2026-08-06 (columns, types, defaults, constraints, indexes, RLS state,
-- policies, grants), so a rebuilt database is type-faithful rather than
-- approximately right.
--
-- Two properties this file must keep:
--
--   1. Every statement is guarded, so applying it to production is a verified
--      no-op rather than an error. That is what lets the same migration set run
--      against both an empty database and the live one.
--   2. It captures each table's CURRENT state, not its original one. Later
--      migrations that alter these tables (20260525_trade_lessons_user_id.sql,
--      20260706_trade_lessons_lesson_type_expand.sql) are already idempotent, so
--      they no-op on a cold replay and the end state still matches production.
--
-- Filename sorts after 20260315175709 (which creates `trades`, referenced by
-- trade_lessons) and before every consumer of `profiles`.
--
-- This is a faithful snapshot, not a cleanup. The broad `anon` grants below are
-- the Supabase/Lovable default and are what production has today; they are held
-- off by RLS. Tightening them is a separate, deliberate change.

-- ── profiles ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id                   UUID        NOT NULL,
  onboarding_completed BOOLEAN     NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ          DEFAULT now(),
  updated_at           TIMESTAMPTZ          DEFAULT now(),
  avatar_url           TEXT,
  display_name         TEXT,
  trading_mode         TEXT        NOT NULL DEFAULT 'paper',
  is_admin             BOOLEAN     NOT NULL DEFAULT false,
  phone                TEXT,
  notification_prefs   JSONB       NOT NULL DEFAULT '{"channel": "email", "agent_alerts": true, "daily_summary": true, "stop_loss_hit": true, "trade_executed": true, "position_closed": true}'::jsonb,
  kalshi_username      TEXT,
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT profiles_trading_mode_check CHECK (trading_mode = ANY (ARRAY['paper'::text, 'live'::text]))
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT USING (auth.uid() = id);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.profiles TO anon, authenticated, service_role;

-- A profile row per auth user. Without this trigger a rebuilt database accepts
-- signups but never creates the profile they depend on, so onboarding, the admin
-- gate and trading-mode selection all read NULL and no user can get past step one.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id) VALUES (new.id) ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── trade_lessons ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_lessons (
  id             UUID        NOT NULL DEFAULT gen_random_uuid(),
  trade_id       UUID,
  ticker         TEXT        NOT NULL,
  strategy_id    TEXT,
  outcome        TEXT,
  lesson_type    TEXT        NOT NULL,
  lesson         TEXT        NOT NULL,
  do_differently TEXT,
  confidence     NUMERIC              DEFAULT 0.7,
  tags           TEXT[]               DEFAULT '{}'::text[],
  trade_context  JSONB                DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ          DEFAULT now(),
  user_id        UUID,
  CONSTRAINT trade_lessons_pkey PRIMARY KEY (id),
  CONSTRAINT trade_lessons_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES public.trades(id) ON DELETE SET NULL,
  CONSTRAINT trade_lessons_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT trade_lessons_confidence_check CHECK (confidence >= 0::numeric AND confidence <= 1::numeric),
  CONSTRAINT trade_lessons_outcome_check CHECK (outcome = ANY (ARRAY['win'::text, 'loss'::text, 'void'::text])),
  -- Kept in step with validLessonTypes in auto-reflect/index.ts; the later
  -- 20260706 migration re-applies this exact list and no-ops here.
  CONSTRAINT trade_lessons_lesson_type_check CHECK (lesson_type = ANY (ARRAY[
    'forecast_bias'::text, 'market_timing'::text, 'stale_signal'::text,
    'kelly_mismatch'::text, 'signal_quality'::text, 'execution'::text,
    'market_structure'::text, 'general'::text
  ]))
);

ALTER TABLE public.trade_lessons ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_trade_lessons_user_id  ON public.trade_lessons USING btree (user_id);
CREATE INDEX IF NOT EXISTS trade_lessons_created_idx  ON public.trade_lessons USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS trade_lessons_strategy_idx ON public.trade_lessons USING btree (strategy_id);
CREATE INDEX IF NOT EXISTS trade_lessons_tags_idx     ON public.trade_lessons USING gin (tags);

DROP POLICY IF EXISTS trade_lessons_read ON public.trade_lessons;
CREATE POLICY trade_lessons_read ON public.trade_lessons
  FOR SELECT TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.trade_lessons TO anon, authenticated, service_role;

-- ── backtest_runs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.backtest_runs (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  strategy_id     TEXT        NOT NULL,
  mode            TEXT        NOT NULL,
  params          JSONB                DEFAULT '{}'::jsonb,
  results         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  trade_count     INTEGER,
  win_rate        NUMERIC,
  avg_edge_cents  NUMERIC,
  total_pnl_cents NUMERIC,
  sharpe_ratio    NUMERIC,
  triggered_by    TEXT                 DEFAULT 'manual'::text,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT backtest_runs_pkey PRIMARY KEY (id)
);

ALTER TABLE public.backtest_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS backtest_runs_started_at_idx    ON public.backtest_runs USING btree (started_at DESC);
CREATE INDEX IF NOT EXISTS backtest_runs_strategy_mode_idx ON public.backtest_runs USING btree (strategy_id, mode, started_at DESC);

DROP POLICY IF EXISTS backtest_runs_read ON public.backtest_runs;
CREATE POLICY backtest_runs_read ON public.backtest_runs
  FOR SELECT TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.backtest_runs TO anon, authenticated, service_role;

-- ── weather_calibration ────────────────────────────────────────────────────
-- RLS on with no policy: readable and writable only by service_role. That is
-- production's state, not an omission.
CREATE TABLE IF NOT EXISTS public.weather_calibration (
  id               UUID        NOT NULL DEFAULT gen_random_uuid(),
  location         TEXT        NOT NULL,
  bias_fahrenheit  NUMERIC     NOT NULL DEFAULT 0,
  rmse_fahrenheit  NUMERIC     NOT NULL DEFAULT 0,
  mad_fahrenheit   NUMERIC     NOT NULL DEFAULT 0,
  sample_count     INTEGER     NOT NULL DEFAULT 0,
  date_range_start DATE,
  date_range_end   DATE,
  model_source     TEXT        NOT NULL DEFAULT 'gfs_ensemble_31member'::text,
  last_backtest_at TIMESTAMPTZ          DEFAULT now(),
  created_at       TIMESTAMPTZ          DEFAULT now(),
  updated_at       TIMESTAMPTZ          DEFAULT now(),
  CONSTRAINT weather_calibration_pkey PRIMARY KEY (id),
  CONSTRAINT weather_calibration_location_key UNIQUE (location)
);

ALTER TABLE public.weather_calibration ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.weather_calibration TO anon, authenticated, service_role;

-- ── weather_bucket_calibration ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.weather_bucket_calibration (
  id                UUID        NOT NULL DEFAULT gen_random_uuid(),
  location_code     TEXT        NOT NULL,
  bucket_threshold  NUMERIC     NOT NULL,
  trade_date        DATE        NOT NULL,
  yes_resolved      BOOLEAN     NOT NULL,
  pnl               NUMERIC,
  side              TEXT,
  ticker            TEXT,
  created_at        TIMESTAMPTZ          DEFAULT now(),
  CONSTRAINT weather_bucket_calibration_pkey PRIMARY KEY (id),
  CONSTRAINT uq_weather_bucket_cal UNIQUE (location_code, trade_date, bucket_threshold, ticker)
);

ALTER TABLE public.weather_bucket_calibration ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_wbc_location_bucket ON public.weather_bucket_calibration USING btree (location_code, bucket_threshold);

GRANT SELECT ON public.weather_bucket_calibration TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.weather_bucket_calibration TO service_role;
