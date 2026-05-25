-- Store Kalshi username fetched from the Kalshi API when the user saves their credentials.
-- Populated automatically by save-kalshi-key edge function — not user-editable.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS kalshi_username TEXT;
