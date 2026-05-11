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
) ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule;
