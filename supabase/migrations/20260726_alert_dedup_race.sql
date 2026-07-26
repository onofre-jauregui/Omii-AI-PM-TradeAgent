-- alertOnce dedup race — closes a duplicate-Telegram-alert gap.
--
-- Motive (2026-07-26 scheduled health check): three identical
-- "Alert sent: kalshi_insufficient_balance" compliance_log rows fired at
-- 2026-07-26 16:05:04.243/.262/.327 UTC — within 84ms of each other, for the
-- same user_id fingerprint. `alertOnce` (_shared/telegram.ts) dedupes by doing
-- a SELECT for an existing alert, then an INSERT if none is found — classic
-- check-then-act with no locking between the two steps. execute-trade invokes
-- alertOnce per basket leg and legs are submitted concurrently (the same
-- concurrency pattern already fixed for the balance pre-flight itself on
-- 2026-07-25, S-001 concurrent legs) — three concurrent legs each ran the
-- SELECT before any of them had committed the INSERT, so all three passed
-- the dedup check and paged Onofre three times for one condition.
--
-- Fix: move the check-and-insert into a single Postgres function guarded by
-- a transaction-scoped advisory lock keyed on (alert_type, fingerprint), so
-- concurrent callers for the same condition serialize and only the first one
-- through actually sends. _shared/telegram.ts calls this RPC atomically
-- instead of doing two separate REST round-trips.

CREATE OR REPLACE FUNCTION public.claim_health_check_alert(
  p_alert_type text,
  p_fingerprint text,
  p_cooldown_hours numeric
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing_id uuid;
BEGIN
  -- Serializes concurrent callers for the same alert_type+fingerprint;
  -- released automatically at transaction end.
  PERFORM pg_advisory_xact_lock(hashtext(p_alert_type || ':' || p_fingerprint)::bigint);

  SELECT id INTO v_existing_id
  FROM public.compliance_log
  WHERE event_type = 'health_check_alert'
    AND metadata->>'alert_type' = p_alert_type
    AND metadata->>'fingerprint' = p_fingerprint
    AND created_at >= now() - (p_cooldown_hours || ' hours')::interval
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.compliance_log (event_type, severity, message, metadata)
  VALUES (
    'health_check_alert',
    'warning',
    'Alert sent: ' || p_alert_type,
    jsonb_build_object('alert_type', p_alert_type, 'fingerprint', p_fingerprint)
  );

  RETURN true;
END;
$$;
