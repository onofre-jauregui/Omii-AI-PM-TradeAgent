-- Subscriptions: unique owner + comp grants ahead of enforcement going live.
--
-- 1) UNIQUE (user_id) was missing. Both stripe-webhook writes use
--    `onConflict: "user_id"`, which requires a unique index to arbiter against —
--    without one PostgREST returns 42P10 and the write fails. The handler
--    discarded that error and stamped the Stripe event "processed" anyway, so
--    every subscription write failed silently and Stripe never retried. This
--    constraint is a prerequisite for billing writes landing at all.
--
-- 2) Two active paper-trading users had no subscriptions row. getEntitlement()
--    reads a missing row as the `free` tier (3 open positions). Shipping real
--    per-tier enforcement to production while they held 10 and 14 open paper
--    positions would have blocked them from opening anything new until those
--    settled below 3. Comped to `starter` (8 open positions) so enforcement does
--    not cut off in-flight users on the day it ships. The cap gates new entries
--    only — held positions are never force-closed, so theirs settle normally.
--
-- Both statements are additive and idempotent; no drops, no data loss.

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);

INSERT INTO subscriptions (user_id, tier, status) VALUES
  ('062d7d20-a1a8-4103-8e63-21139d061e85', 'starter', 'active'),
  ('2e64cc4c-83ab-42c5-ac1b-32fcd5a26e1a', 'starter', 'active')
ON CONFLICT (user_id) DO UPDATE
  SET tier = EXCLUDED.tier,
      status = EXCLUDED.status,
      updated_at = now();
