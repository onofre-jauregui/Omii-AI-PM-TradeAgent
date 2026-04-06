-- Enable pg_cron and pg_net extensions for scheduled HTTP calls
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Schedule auto-reflect to run every hour.
-- Uses pg_net to call the edge function.
-- The service_role key is read from vault or set via Supabase dashboard.
--
-- NOTE: After applying this migration, you must set the cron job's
-- HTTP target via the Supabase Dashboard > Database > Cron Jobs,
-- or run the SELECT below replacing the placeholders with your
-- actual SUPABASE_URL and SERVICE_ROLE_KEY.

-- Create a helper function that the cron job calls.
-- This avoids hardcoding secrets in cron.schedule().
CREATE OR REPLACE FUNCTION public.invoke_auto_reflect()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _url text;
  _key text;
BEGIN
  -- These are automatically available in Supabase edge runtime
  _url := current_setting('request.headers', true)::json ->> 'x-supabase-url';

  -- Fallback: use the project ref directly
  IF _url IS NULL OR _url = '' THEN
    _url := 'https://uyfnezxmgwitpzsrnkst.supabase.co';
  END IF;

  -- Service role key from vault (if configured) or hardcoded fallback
  SELECT decrypted_secret INTO _key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  -- If vault not set up, skip silently (function will be called manually or via dashboard cron)
  IF _key IS NULL THEN
    RAISE NOTICE 'auto-reflect: service_role_key not found in vault, skipping. Set up via Supabase Dashboard > Cron Jobs.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := _url || '/functions/v1/auto-reflect',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
END;
$$;

-- Schedule: run every hour
SELECT cron.schedule(
  'auto-reflect-hourly',
  '0 * * * *',
  'SELECT public.invoke_auto_reflect()'
);
