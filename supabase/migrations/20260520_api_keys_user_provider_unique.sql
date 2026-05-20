-- Add partial unique index on (user_id, provider) for non-null user_id rows.
-- Required so Supabase upsert with onConflict: "user_id,provider" resolves correctly.
-- System rows (user_id IS NULL) are excluded — they're managed separately.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_user_id_provider_unique
  ON public.api_keys (user_id, provider)
  WHERE user_id IS NOT NULL;
