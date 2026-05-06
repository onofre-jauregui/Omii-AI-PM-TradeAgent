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
) ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command;
