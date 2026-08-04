# Runbook — rolling back a `dev → main` promotion

**When to use:** the canary gate (CI job 7) aborted, or production is misbehaving after a promotion and you need to get back to the previous edge-function build.

**Read this first:** the canary rolls back **edge functions and the Vercel frontend. It never rolls back migrations.** Every migration this repo applies is additive, so old code tolerates the new schema — *with one exception, documented below, which will break every risk-state write if you miss it.*

---

## 1. What the canary already did for you

`canary-gate` in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) polls `compliance_log` every 60s for 30 minutes and aborts if more than 5 of these appear in any 5-minute window: `auto_trade_error`, `auto_trade_strategy_error`, `strategy_auto_halted`, `kalshi_circuit_open`, `risk_check_failed`.

On abort it redeploys every edge function from `HEAD~1` and runs `vercel rollback`. If it aborted, **the functions are already back**; go straight to §2.

If you are rolling back manually:

```bash
source ~/.omii_env
git checkout <prior-sha> -- supabase/functions/
for fn in $(ls supabase/functions/ | grep -v _shared | grep -v tests); do
  SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA \
    npx supabase functions deploy "$fn" --project-ref uyfnezxmgwitpzsrnkst
done
git checkout HEAD -- supabase/functions/
npx vercel rollback --yes
```

## 2. The compensating SQL — required if you roll back past 2026-08-01

Two migrations from the 2026-08-03 promotion changed the schema in ways the *older* code cannot survive. If the build you are rolling back to predates them, apply the matching block below. If your rollback target is newer than these, skip this section.

### 2a. `risk_state` unique constraint — **this one is load-bearing**

[`20260801_risk_state_mode.sql`](../../supabase/migrations/20260801_risk_state_mode.sql) dropped the `(user_id, date)` unique constraint and replaced it with `(user_id, date, mode)`. Code older than that migration upserts with `onConflict: "user_id,date"`, which now matches **no** constraint — every risk-state write fails, and trading proceeds with no daily-loss guard or position tracking. That is a silent, money-relevant failure.

Collapse the per-mode rows and restore the old constraint:

```sql
-- Keep the live row where both exist (it is the money-bearing one); if only
-- paper exists, keep that. Ties broken by most recently updated.
DELETE FROM public.risk_state a
USING public.risk_state b
WHERE a.user_id IS NOT DISTINCT FROM b.user_id
  AND a.date = b.date
  AND a.id <> b.id
  AND (
    (b.mode = 'live' AND a.mode = 'paper')
    OR (a.mode = b.mode AND a.updated_at < b.updated_at)
  );

DROP INDEX IF EXISTS public.risk_state_user_date_mode_key;

ALTER TABLE public.risk_state
  ADD CONSTRAINT risk_state_user_date_key UNIQUE (user_id, date);
```

Verify before declaring the rollback done:

```sql
SELECT conname FROM pg_constraint WHERE conrelid = 'public.risk_state'::regclass;
-- must list risk_state_user_date_key
```

Then place one paper trade and confirm a `risk_state` row updates.

### 2b. `strategy_config` INSERT grant

[`20260731_p0_strategy_config_seed_and_grants.sql`](../../supabase/migrations/20260731_p0_strategy_config_seed_and_grants.sql) revoked `INSERT` on `strategy_config` from `authenticated`, because a DB trigger now seeds the row on strategy creation. Frontend builds older than that still call `.upsert()`, and `INSERT ... ON CONFLICT` needs the INSERT privilege even when it resolves to an update — the position-size control will fail silently.

```sql
GRANT INSERT ON public.strategy_config TO authenticated;
```

## 3. What is *not* rolled back, and does not need to be

| Change | Why old code is fine with it |
|---|---|
| `signal_claims` table | Older `auto-trade` filters on `signals.was_acted_on`, which is still written. The claims table simply stops being read |
| `signals.settlement_status` | Nullable column; older `settle-signals` ignores it |
| Cron registrations (`weather-signal`, `paper-reconcile`, `compliance-log-retention`) | Jobs call functions by URL; the deployed function version is whatever you rolled back to |
| `risk_state.mode` column itself | Has a `'paper'` default, so inserts that omit it still succeed — it is only the *unique constraint* in §2a that breaks |

## 4. After any rollback

1. Confirm `compliance_log` error volume returns to baseline (~0–2 `error` rows/hour).
2. Confirm the next `auto_trade_run` heartbeat lands (5-minute cadence).
3. Confirm `kalshitradeagent.com` serves the rolled-back build.
4. Open an issue with the canary's `drift-diff` artifact attached before re-attempting the promotion — a rollback that isn't diagnosed just gets repeated.

---

**Provenance:** written 2026-08-04, immediately after the 2026-08-03 promotion (PRs #176 → failed pipeline → #178 replay fix → #179 green). The §2a hazard was identified by reading the migration against the pre-promotion code, not by experiencing it — it has **not** been exercised against a live rollback. Dry-run §2a on staging before trusting it in an incident.
