-- Fixes a bug in the 46th-run fix (20260728_register_settle_signals_cron.sql,
-- same run/PR): once settle-signals-cron started actually running, its query
-- (`WHERE settlement_price IS NULL AND expires_at < now() LIMIT 200`, no
-- ORDER BY) re-selected the *same* oldest ~200 signals on every 15-minute
-- tick — confirmed via compliance_log: 5 consecutive ticks from 06:13 to
-- 07:00 UTC returned the identical 200 tickers, all Kalshi 404 (archive
-- retention aged out), zero rotation. This was flagged as an open "watch
-- item, not yet confirmed" in that same run's health-log entry; this run
-- confirmed it live and closes it. With zero rotation, the real backlog of
-- ~20,700 other unsettled signals behind that stuck batch would never get a
-- chance to settle — the cron would spin forever re-hitting an unresolvable
-- batch instead of making progress.
--
-- Fix: distinguish "still needs checking" from "permanently unsettleable"
-- (Kalshi 404 = ticker aged out of archive retention, will never resolve)
-- via a dedicated settlement_status column, so the function (edited
-- alongside this migration) can stamp settled_at on 404s without faking a
-- settlement_price/shadow_pnl, and the query can gate on settled_at to
-- exclude them from future batches. Additive/nullable, no data migration.

ALTER TABLE signals ADD COLUMN IF NOT EXISTS settlement_status text;

COMMENT ON COLUMN signals.settlement_status IS
  'null = settled normally or still pending; ''unsettleable_404'' = Kalshi returned 404 (ticker aged out of archive retention), settled_at stamped to stop re-selection but settlement_price/shadow_pnl intentionally left null.';
