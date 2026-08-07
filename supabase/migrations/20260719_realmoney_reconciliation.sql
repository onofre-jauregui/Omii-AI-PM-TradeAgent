-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- ═══════════════════════════════════════════════════════════════════════════
-- Real-money trading — fill reconciliation + live settlement (W3)
--
-- Apply via the management API (same as 20260719_realmoney_foundation.sql).
-- Apply AFTER 20260719_realmoney_foundation.sql and AFTER deploying the
-- reconcile-orders edge function.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Settle LIVE trades, not just paper ────────────────────────────────────
-- The pending-resolution view (what auto-settle reads) was hard-filtered to
-- mode='paper', so a filled LIVE order was never PnL-settled. Include live so
-- real-money fills settle at market resolution the same way paper does. Still
-- action='buy' only (computePnl handles buys; sell-side settlement is a separate
-- enhancement and matches the existing paper behavior).
DROP VIEW IF EXISTS public.agent_trades_pending_resolution CASCADE;
CREATE VIEW public.agent_trades_pending_resolution AS
SELECT
  ticker,
  user_id,
  count(*) AS trades_pending,
  array_agg((id)::text ORDER BY created_at) AS trade_ids,
  min(created_at) AS earliest_entry
FROM trades
WHERE
  mode IN ('paper', 'live')
  AND status = 'filled'
  AND action = 'buy'
  AND settled_at IS NULL
  AND ticker IS NOT NULL
GROUP BY ticker, user_id;

-- ── 2. reconcile-orders cron — advance resting live orders every 5 minutes ────
-- Polls Kalshi for each live order still in status open/partial and advances the
-- local trades row (→ filled / partial / cancelled). Without this, a live limit
-- order that fills after submission is never captured. The health-check staleness
-- watchdog (cron_health()) auto-discovers this job from cron.job — no manual
-- registration needed. Offset to :01,:06,… to stagger off auto-settle's */10.
SELECT cron.schedule(
  'reconcile-orders-cron',
  '1-59/5 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL')
               || '/functions/v1/reconcile-orders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body    := '{}'::jsonb
  );
  $$
);
