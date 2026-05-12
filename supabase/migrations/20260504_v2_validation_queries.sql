-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-Reflect v2 — Validation Gates (run after 14 days of v2 paper trading)
-- 2026-05-04
--
-- Use these queries to decide what stays and what goes.
-- All queries filter on system_version = 'v2' to separate from v1 baseline.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Qualifier ROI ───────────────────────────────────────────────────────
-- Should be > 0. If consistently negative, the qualifier is destroying value.
-- (Requires shadow PnL to be populated by settle-signals cron.)

CREATE OR REPLACE VIEW qualifier_roi_v2 AS
SELECT
  date_trunc('day', s.created_at) AS day,
  s.strategy_id,
  count(*) FILTER (WHERE s.was_acted_on) AS acted_count,
  count(*) FILTER (WHERE NOT s.was_acted_on) AS skipped_count,
  avg(s.shadow_pnl) FILTER (WHERE s.was_acted_on) AS avg_acted_shadow_pnl,
  avg(s.shadow_pnl) FILTER (WHERE NOT s.was_acted_on) AS avg_skipped_shadow_pnl,
  avg(s.shadow_pnl) FILTER (WHERE s.was_acted_on) -
    avg(s.shadow_pnl) FILTER (WHERE NOT s.was_acted_on) AS qualifier_lift
FROM signals s
WHERE s.settled_at IS NOT NULL
  AND s.system_version = 'v2'
GROUP BY 1, 2;

-- Run:
SELECT avg(qualifier_lift) AS avg_lift
FROM qualifier_roi_v2
WHERE day > now() - interval '14 days';

-- ─── 2. Memory Citation Lift ────────────────────────────────────────────────
-- Trades influenced by high-confidence memory should have meaningfully higher
-- avg PnL. If not, the learning loop is theater.

WITH trade_groups AS (
  SELECT
    t.id,
    t.pnl,
    EXISTS (
      SELECT 1 FROM memory_attribution ma
      JOIN agent_memory m ON ma.memory_id = m.id
      WHERE ma.trade_id = t.id
        AND m.exposed_confidence > 0.6
    ) AS influenced_by_high_conf
  FROM trades t
  WHERE t.system_version = 'v2'
    AND t.settled_at > now() - interval '14 days'
    AND t.pnl IS NOT NULL
)
SELECT
  influenced_by_high_conf,
  avg(pnl) AS avg_pnl,
  count(*) AS n,
  sum(pnl) AS total_pnl
FROM trade_groups
GROUP BY 1;

-- KILL CRITERION: If the high-conf group has no PnL lift after 14 days,
-- rip out the memory loop. Keep only strategy health + shadow PnL.

-- ─── 3. Suspension Precision ────────────────────────────────────────────────
-- Of strategies suspended, how many stayed bad after resumption?
-- Manual review — too situational for a single query.

SELECT
  cl.created_at,
  cl.event_type,
  cl.message,
  cl.metadata->>'strategy_id' AS strategy_id,
  cl.metadata->>'sharpe' AS sharpe,
  cl.metadata->>'max_drawdown' AS max_drawdown,
  cl.metadata->>'hit_rate' AS hit_rate
FROM compliance_log cl
WHERE cl.event_type LIKE 'strategy_suspended%'
  AND cl.created_at > now() - interval '14 days'
ORDER BY cl.created_at DESC;

-- Then check: did these strategies recover after resumption?
-- SELECT s.name, s.active, s.suspended_until, s.suspension_reason
-- FROM strategies s
-- WHERE s.id IN (...suspended strategy IDs...);

-- ─── 4. Memory Churn Rate ───────────────────────────────────────────────────
-- Quarantined / total. >50% = noisy memory generation. <10% = stable.

SELECT
  count(*) FILTER (WHERE quarantined_at IS NOT NULL
    AND quarantined_at < created_at + interval '30 days') * 1.0
  / NULLIF(count(*), 0) AS churn_30d,
  count(*) AS total_v2_memories,
  count(*) FILTER (WHERE quarantined_at IS NOT NULL) AS quarantined,
  count(*) FILTER (WHERE exposed_confidence IS NOT NULL) AS exposed,
  count(*) FILTER (WHERE exposed_confidence IS NULL) AS unexposed,
  avg(exposed_confidence) FILTER (WHERE exposed_confidence IS NOT NULL) AS avg_exposed_conf
FROM agent_memory
WHERE system_version = 'v2'
  AND created_at < now() - interval '30 days';

-- ─── 5. Shadow PnL Coverage ─────────────────────────────────────────────────
-- What % of signals have been settled? Should approach 100% over time.

SELECT
  count(*) FILTER (WHERE settled_at IS NOT NULL) AS settled,
  count(*) FILTER (WHERE settled_at IS NULL) AS pending,
  count(*) FILTER (WHERE settled_at IS NOT NULL) * 100.0 /
    NULLIF(count(*), 0) AS settle_rate_pct,
  avg(shadow_pnl) FILTER (WHERE settled_at IS NOT NULL) AS avg_shadow_pnl
FROM signals
WHERE system_version = 'v2'
  AND created_at < now() - interval '7 days';

-- ─── 6. Signal-Trade Linkage Completeness ───────────────────────────────────
-- All v2 acted-on signals older than 24h should link to a trade.

SELECT count(*) AS unlinked_acted_signals
FROM signals s
WHERE s.was_acted_on = true
  AND s.system_version = 'v2'
  AND s.created_at < now() - interval '24 hours'
  AND NOT EXISTS (
    SELECT 1 FROM trades t WHERE t.source_signal_id = s.id
  );
-- Expect 0 (or very low, only edge cases where trade failed after signal)

-- ─── 7. Strategy Health v2 — Current Metrics ────────────────────────────────
-- Quick snapshot of all strategies' rolling metrics.

SELECT
  s.id,
  s.name,
  s.active,
  s.suspension_reason,
  s.expected_hit_rate,
  s.max_acceptable_drawdown,
  (SELECT count(*) FROM trades
   WHERE status = 'filled'
     AND settled_at IS NOT NULL
     AND (strategy_id = s.id OR strategy = s.name)) AS settled_trades,
  (SELECT avg(pnl) FROM trades
   WHERE status = 'filled'
     AND settled_at IS NOT NULL
     AND (strategy_id = s.id OR strategy = s.name)
     AND system_version = 'v2') AS avg_pnl_v2,
  (SELECT count(*) FILTER (WHERE pnl > 0) * 1.0 / NULLIF(count(*), 0)
   FROM trades
   WHERE status = 'filled'
     AND settled_at IS NOT NULL
     AND (strategy_id = s.id OR strategy = s.name)
     AND system_version = 'v2') AS hit_rate_v2
FROM strategies s
ORDER BY s.id;

-- ─── 8. Auto-Trade Lock Health ──────────────────────────────────────────────
-- Lock table should be empty between runs. If non-zero, a run is stuck.

SELECT
  lock_name,
  run_id,
  acquired_at,
  extract(epoch FROM now() - acquired_at) / 60 AS age_minutes
FROM auto_trade_locks;
-- Expect 0 rows. If a row exists, check if age > 5 min (stale lock).
