-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- Schedule futures-signal edge function every 30 minutes.
-- This drives S-001 FedWatch Oracle signal generation.
-- Note: CME FedWatch may be unavailable from cloud IPs; function fails gracefully
-- and logs to compliance_log when that happens.
SELECT cron.schedule(
  'futures-signal-cron',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL') || '/functions/v1/futures-signal',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
