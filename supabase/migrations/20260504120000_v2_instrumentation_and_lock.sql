-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-Reflect v2 — Instrumentation, Advisory Lock, and System Version Tagging
-- 2026-05-04
--
-- This migration adds:
--   1. system_version columns for v1/v2 separation
--   2. Memory attribution tables (trade↔memory PnL tracking)
--   3. Shadow PnL fields on signals (learn from skipped signals)
--   4. Bayesian memory fields (alpha/beta posterior confidence)
--   5. Strategy health v2 fields (Sharpe, drawdown, hit rate)
--   6. Signal↔trade linkage (kill 2-hour heuristic)
--   7. Auto-trade advisory lock table (race condition protection at 30s polling)
--   8. Auto-trade cron updated from 5min → 30 seconds
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. System Version Tagging
-- ─────────────────────────────────────────────────────────────────────────────
-- Default remains 'v1'. After v2 code ships, new writes use 'v2'.
-- All v2 metric queries filter on system_version = 'v2'.

ALTER TABLE trades ADD COLUMN IF NOT EXISTS system_version text DEFAULT 'v1';
ALTER TABLE signals ADD COLUMN IF NOT EXISTS system_version text DEFAULT 'v1';
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS system_version text DEFAULT 'v1';

CREATE INDEX IF NOT EXISTS idx_trades_system_version ON trades (system_version);
CREATE INDEX IF NOT EXISTS idx_signals_system_version ON signals (system_version);
CREATE INDEX IF NOT EXISTS idx_agent_memory_system_version ON agent_memory (system_version);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Memory Attribution — which memories influenced which trades
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE trades ADD COLUMN IF NOT EXISTS influenced_by_memory_ids uuid[] DEFAULT '{}';

CREATE TABLE IF NOT EXISTS memory_attribution (
  trade_id uuid NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL REFERENCES agent_memory(id) ON DELETE CASCADE,
  cited_at timestamptz NOT NULL DEFAULT now(),
  trade_pnl numeric,        -- backfilled when trade settles
  settled_at timestamptz,   -- null until trade resolves
  PRIMARY KEY (trade_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_attribution_memory ON memory_attribution(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_attribution_settled ON memory_attribution(settled_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Shadow PnL on signals — learn from signals you skipped, not just traded
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE signals ADD COLUMN IF NOT EXISTS shadow_pnl numeric;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS settlement_price numeric;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS settled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_signals_shadow_settled ON signals (settled_at) WHERE shadow_pnl IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Bayesian Memory Fields — replace rule-based confidence
-- ─────────────────────────────────────────────────────────────────────────────

-- Scoping: 'global', 'strategy:{strategy_id}', 'market:{market_type}'
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS scope text DEFAULT 'global';

ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS last_updated_at timestamptz DEFAULT now();
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS trade_sample_size int DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS alpha numeric DEFAULT 1;   -- Beta prior: wins
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS beta numeric DEFAULT 1;    -- Beta prior: losses
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS exposed_confidence numeric; -- null = don't show to qualifier
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS quarantined_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_agent_memory_quarantined ON agent_memory (quarantined_at) WHERE quarantined_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_memory_exposed ON agent_memory (exposed_confidence) WHERE exposed_confidence IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Strategy Health v2 — Sharpe + drawdown (replaces consecutive-loss only)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE strategies ADD COLUMN IF NOT EXISTS expected_hit_rate numeric DEFAULT 0.50;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS max_acceptable_drawdown numeric DEFAULT 0.25;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS suspension_reason text;

-- Backfill conservative defaults for existing strategies
UPDATE strategies
SET expected_hit_rate = 0.50,
    max_acceptable_drawdown = 0.25
WHERE expected_hit_rate IS NULL OR max_acceptable_drawdown IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Signal↔Trade Linkage — kill the 2-hour heuristic
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE trades ADD COLUMN IF NOT EXISTS source_signal_id uuid REFERENCES signals(id);
CREATE INDEX IF NOT EXISTS idx_trades_source_signal ON trades(source_signal_id);

ALTER TABLE signals ADD COLUMN IF NOT EXISTS direction_correct bool;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS profitable bool;

COMMENT ON COLUMN signals.outcome_correct IS 'DEPRECATED — use direction_correct + profitable';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Compaction Audit — reversible LLM memory compaction
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS compaction_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compacted_at timestamptz NOT NULL DEFAULT now(),
  source_memory_ids uuid[] NOT NULL,
  source_memory_snapshot jsonb NOT NULL,  -- full content before merge
  result_memory_id uuid NOT NULL,
  reversed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_compaction_log_result ON compaction_log(result_memory_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Auto-Trade Advisory Lock — table-based (not pg_try_advisory_lock)
-- ─────────────────────────────────────────────────────────────────────────────
-- Why table-based: Supabase uses pgbouncer connection pooler. pg_try_advisory_lock
-- is scoped to a database session — each net.http_post to an edge function gets
-- its own HTTP request, so advisory locks won't persist across the boundary.
-- A table with single-row upsert is atomic and survives connection pooling.

CREATE TABLE IF NOT EXISTS auto_trade_locks (
  lock_name text PRIMARY KEY DEFAULT 'auto_trade',
  acquired_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid NOT NULL
);

ALTER TABLE auto_trade_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on auto_trade_locks"
  ON auto_trade_locks FOR ALL USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Update auto-trade cron from 5 minutes to 30 seconds
-- ─────────────────────────────────────────────────────────────────────────────

-- Replace the existing auto-trade-cron with 30-second interval
SELECT cron.schedule(
  'auto-trade-cron',
  '30 seconds',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL') || '/functions/v1/auto-trade',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{}'::jsonb
  );
  $$
) ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Settle-signals cron — every 15 minutes
-- ─────────────────────────────────────────────────────────────────────────────

SELECT cron.schedule(
  'settle-signals-cron',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL') || '/functions/v1/settle-signals',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{}'::jsonb
  );
  $$
);
