-- Kalshi ledger reconciliation: mark which P&L numbers are truth-backed.
--
-- `pnl`/`net_pnl` have always been derived from the requested limit price and
-- dollar amount, never from what actually filled and settled. Nothing in the
-- row said so, which is how a corrupt 2026-07-27 backfill (net_pnl greater than
-- gross; a $10 position recorded as losing $21.53) sat undetected and was
-- quoted as fact.
--
-- kalshi_reconciled_at is set only by the reconcile-ledger function, and only
-- after that row's numbers have been rewritten from /portfolio/settlements. A
-- NULL means "estimated, not yet confirmed against the exchange" — a distinction
-- any P&L consumer can now make.
--
-- Idempotent: every statement is guarded or self-upserting, because the pipeline
-- records a version only after a successful apply and therefore replays whole
-- files. cron.schedule() upserts by jobname internally — do NOT append
-- ON CONFLICT to it (a SELECT has no ON CONFLICT semantics; that mistake left
-- reconcile-orders-cron and paper-reconcile-cron unregistered for days).

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS kalshi_reconciled_at TIMESTAMPTZ;

COMMENT ON COLUMN public.trades.kalshi_reconciled_at IS
  'When this row''s pnl/net_pnl were last rewritten from Kalshi /portfolio/settlements. NULL = derived estimate, not exchange-confirmed.';

-- The reconciler looks up live rows one ticker at a time, per tenant.
CREATE INDEX IF NOT EXISTS trades_live_ticker_user_idx
  ON public.trades (user_id, ticker)
  WHERE mode = 'live';

-- Hourly at :20 — clear of auto-settle (:02 and every 10 min) so it reads
-- settlements that have already landed rather than racing the writer.
SELECT cron.schedule(
  'reconcile-ledger-hourly',
  '20 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL')
               || '/functions/v1/reconcile-ledger',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Declare it to the watchdog: cron_health() only iterates FROM cron.job, so a
-- job that silently fails to register is invisible unless it is listed here.
INSERT INTO public.expected_cron_jobs (jobname, note)
VALUES ('reconcile-ledger-hourly', 'Rewrites live trade pnl/net_pnl from the Kalshi settlements ledger')
ON CONFLICT (jobname) DO NOTHING;
