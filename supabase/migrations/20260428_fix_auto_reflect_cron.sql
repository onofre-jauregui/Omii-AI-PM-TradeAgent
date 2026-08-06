-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- Fix auto-reflect cron: was silently skipping because it looked up
-- 'service_role_key' in vault, but the vault stores it as 'SUPABASE_SERVICE_ROLE_KEY'.
-- Match the pattern used by all other working crons (futures-signal, auto-trade, etc.)

SELECT cron.unschedule('auto-reflect-hourly');

SELECT cron.schedule(
  'auto-reflect-hourly',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL') || '/functions/v1/auto-reflect',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
