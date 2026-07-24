-- Per-strategy run cadence.
-- run_interval_minutes: minimum minutes between auto-trade evaluations for this
--   strategy. NULL = run every cron cycle (current behavior, hourly).
-- last_run_at: set by auto-trade each time the strategy passes its cadence gate;
--   only written for strategies with a non-null interval, so default-hourly
--   strategies generate no extra realtime churn.
ALTER TABLE strategies
  ADD COLUMN IF NOT EXISTS run_interval_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

ALTER TABLE strategies
  ADD CONSTRAINT strategies_run_interval_positive
  CHECK (run_interval_minutes IS NULL OR run_interval_minutes > 0) NOT VALID;

ALTER TABLE strategies VALIDATE CONSTRAINT strategies_run_interval_positive;
