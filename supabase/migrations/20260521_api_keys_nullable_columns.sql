-- encrypted_secret and key_id must be nullable.
-- Kalshi keys use secret_ciphertext + secret_iv (AES-256-GCM).
-- Setting encrypted_secret = null on those rows was failing NOT NULL,
-- silently rejecting every Kalshi key save.
ALTER TABLE public.api_keys ALTER COLUMN encrypted_secret DROP NOT NULL;
ALTER TABLE public.api_keys ALTER COLUMN key_id DROP NOT NULL;
