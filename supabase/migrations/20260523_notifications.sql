-- Add phone number and notification_prefs to profiles.
-- notification_prefs stores both channel preference and which event types fire.
-- channel: "email" | "sms" | "both"
-- daily_summary defaults false — users must opt in explicitly.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT
    '{"channel":"email","daily_summary":false,"trade_executed":true,"position_closed":true,"stop_loss_hit":true,"agent_alerts":true}'::jsonb;

-- daily-digest cron registered separately via management API after function deploy.
-- 0 22 * * * UTC = 6pm ET (EDT, UTC-4). Update to 23:00 when clocks fall back.
