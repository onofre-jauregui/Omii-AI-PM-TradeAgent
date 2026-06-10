-- Enforce one risk_settings row per user so upsert works correctly.
-- Without this, onboarding inserts duplicate rows and auto-trade falls back
-- to the system default (max_open_positions=10) for users missing an explicit row.
ALTER TABLE risk_settings ADD CONSTRAINT risk_settings_user_id_unique UNIQUE (user_id);
