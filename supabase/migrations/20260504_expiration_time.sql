-- Add expiration_time column to trades for position aging
-- Applied 2026-05-04: auto-trade now passes settlement date from ticker parsing
-- Going forward, all new trades will have expiration_time populated.
-- Legacy trades will use parseSettlementDate() as fallback.

ALTER TABLE trades ADD COLUMN IF NOT EXISTS expiration_time TIMESTAMPTZ;
