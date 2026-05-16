-- NULL out the legacy plaintext encrypted_secret column for any rows that
-- already have AES-256-GCM ciphertext stored in secret_ciphertext.
-- getKalshiCredentials() checks secret_ciphertext first, so this removal
-- is safe — it eliminates the plaintext fallback for already-encrypted rows.

UPDATE public.api_keys
SET encrypted_secret = NULL
WHERE secret_ciphertext IS NOT NULL
  AND encrypted_secret IS NOT NULL;

COMMENT ON COLUMN public.api_keys.encrypted_secret IS
  'DEPRECATED — plaintext despite misleading name. NULL for any row where secret_ciphertext is set. Will be dropped once all rows are migrated.';
