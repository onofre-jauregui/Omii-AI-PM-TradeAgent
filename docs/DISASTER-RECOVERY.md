---
version: 2
updated: 2026-08-06
status: current
---

# Disaster recovery — rebuilding the database

What to do if the Supabase project `uyfnezxmgwitpzsrnkst` is lost: deleted, corrupted, or made unrecoverable.

This is not theoretical. A sibling OMII project's Supabase project was **deleted** — not paused — on 2026-07-20, taking every row and every login with it. It recovered because its migration set had been proven to rebuild the schema from zero. Until 2026-08-06, TradeAgent's could not have.

## What survives, and what does not

| | |
|---|---|
| **Schema** | Survives. `supabase/migrations/` rebuilds it from zero — 73 migrations, verified clean, in about 3 seconds. |
| **Edge functions** | Survive in `supabase/functions/`. Redeploy with the CLI. |
| **Cron jobs** | Survive as `cron.schedule()` calls inside the migrations, and are cross-checked against `expected_cron_jobs`. |
| **Row data** | **Does not survive** without a Supabase point-in-time restore. Trades, agent memory and encrypted API keys are gone. |
| **Logins** | **Do not survive.** `auth.users` rebuilds empty; every user re-signs-up. |
| **Vault secrets** | Do not survive. Re-seed `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, or every cron silently no-ops. |

Restoring row data means Supabase support and a backup. Everything below assumes the schema is what you are rebuilding.

## Rebuild

### 1. Rehearse first — always

Runs against a throwaway local database and touches nothing hosted:

```
npm run db:rehearse
```

It must finish with:

```
Rebuilt from zero — 73 migrations applied clean, twice, catalog matches.
```

If it does not, **stop**. The migration set is broken and rebuilding a live project will fail partway through, leaving a half-migrated database that is worse than an empty one. Fix the reported migration first.

The script needs one of: a running local Postgres (`brew services start postgresql@17`), Docker, or `REHEARSAL_DSN` pointing at an empty local database. Exit codes: `0` clean, `1` a migration failed or the schema drifted, `2` preconditions unmet.

Use `--keep` to leave the rebuilt database up for inspection, `--survey` to apply everything and report *all* failures rather than stopping at the first, and `--write-fingerprint` to re-record `scripts/expected-schema.json` after an intentional schema change — always in the same commit as the migration that caused it, so the diff gets reviewed.

The rebuilt catalog is compared to that fingerprint **by name**: every column with its type, default and nullability, every view, function, RLS policy, index, constraint and trigger. Counts were the original check and were not enough — on 2026-08-06 the count check reported "counts match" while twelve RLS policies, three column types and four constraints differed from production.

### 2. Create the new project and apply

Create a fresh Supabase project, then apply the migrations through the Management API in filename-sorted order — the same path `.github/workflows/ci.yml` uses. **Never `npx supabase db push`**: this repo's migration history is out of sync with any remote.

> **Never apply `scripts/supabase-shim.sql` to a hosted project.** It is a local test fixture that stands in for the `auth` schema, the `anon`/`authenticated`/`service_role` roles, pg_cron, pg_net, Vault and Storage. On a real project those already exist, and the shim would shadow the platform's own auth functions. `scripts/rehearse-migrations.sh` refuses a hosted DSN for this reason.

### 3. Re-seed what the schema cannot carry

- **Vault:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Every cron reads these; without them each one runs and does nothing.
- **Edge-function secrets:** `KALSHI_API_KEY`, `KALSHI_PRIVATE_KEY`, `API_KEY_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, the Stripe set, `ALLOWED_ORIGIN(S)`, `FRONTEND_URL`, Langfuse, Sentry, Tavily. `API_KEY_ENCRYPTION_KEY` must be the **original value** or every stored user Kalshi key becomes undecryptable.
- **Frontend:** repoint `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Vercel, then redeploy — env vars bind at deploy time, so a redeploy is required before any live test means anything.
- **Users:** re-signup. `handle_new_user()` creates each profile row automatically.

### 4. Verify

```
./scripts/verify-agent-memory-isolation.sh <new-project-ref>
```

Then confirm `cron_health()` reports every job in `expected_cron_jobs` as registered, and walk the dashboard on the live URL with a real login.

## Preventing a repeat

**Migration drift is now guarded.** `rehearse-migrations` runs as a blocking CI job on every push and PR, so the migration set cannot silently stop being able to rebuild the schema. Run `npm run db:rehearse` after any schema change.

That guard immediately found four classes of real defect on its first run:

1. **Five tables existed only in production** — `profiles`, `trade_lessons`, `backtest_runs`, `weather_calibration`, `weather_bucket_calibration` — along with six columns, five indexes, four views, two dashboard RPCs, and `handle_new_user()` with its trigger on `auth.users`. All were typed into the dashboard and never written down. Without `handle_new_user()` a rebuilt database accepts signups and never creates the profile row they depend on, so nobody gets past onboarding.
2. **Twenty `cron.schedule(...)` calls were closed by an upsert clause that belongs to `INSERT`, not `SELECT`.** Invalid SQL, so those files could never apply cleanly to any database — Supabase included. This is why production is missing `compaction_log` and the `open_positions` view: `20260504120000` aborted partway and was recorded as applied anyway.
3. **`20260610_risk_settings_unique_user.sql` failed on every re-run**, adding a constraint with no existence guard.
4. **`trades.source_signal_id` was declared `uuid` in git and is `text` in production**, so a rebuilt database would have broken the `signal_claims` backfill that applies a regex to it.

Switching the assertion from counts to a named catalog fingerprint then found four more, none of which the counts could see:

5. **`Allow all access to api_keys` — `FOR ALL`, `TO public`, `USING (true)` — was still in the migration set.** Postgres OR's permissive policies, so it overrides `api_keys_user_isolation`: a database rebuilt from git would expose every user's encrypted Kalshi credentials to `anon` through PostgREST. Production had dropped it by hand and the drop was never recorded. The same applied to `risk_settings`, `strategies` and `compliance_log`.
6. **`compliance_log`'s inline CHECK is a closed 14-value allowlist that excludes `health_check_alert`** — which `20260726_alert_dedup_race.sql` writes. Production replaced it with the category-gated `compliance_event_type_allowlist`; a rebuilt database would reject writes production accepts.
7. **Three more column types diverged** — `signals.edge_cents` (`integer` in git, `numeric` in production), `trades.influenced_by_memory_ids` (`uuid[]` vs `text[]`) and `auto_trade_locks.run_id` (`uuid` vs `text`) — plus four defaults and two index names.
8. **`risk_settings_user_unique` never took in production**, and production currently holds **11 `user_id`s with duplicate `risk_settings` rows**. Which row wins when risk caps are read is arbitrary. Deduplicating is a data change and is not done here.

**Known remaining drift**, recorded in full under `_production_delta_2026_08_06` in `scripts/expected-schema.json`. Production is missing one table (`compaction_log`), one view (`open_positions`) and eight indexes, all from `20260504120000` aborting partway and `20260610` failing outright while both were recorded as applied. Reconcile before relying on any of them; `risk_settings_user_unique` additionally cannot be added until the 11 duplicate rows are resolved.
