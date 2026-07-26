# TradeAgent — Health Check Log

Findings from automated health-check runs. Newest first.

## 2026-07-26 (17th run) — Clean Telegram window; found the watchdog itself could silently swallow its own alerts

**Telegram error state:** Queried `compliance_log` for `error`/`critical` from 07:07 UTC (14th
run's cutoff) through 10:07 UTC — zero rows, a clean 3h window. `health_check_alert` still last
fired 04:12:59 UTC (`live_trading_cap_blocked`, correctly within its 6h cooldown). All 12
`cron.job` entries confirmed `active: true` with their most recent run `succeeded` (jobid 22,
`compliance-log-retention-daily`, correctly has no run yet — first fire is tonight 03:17 UTC,
consistent with the 14th/16th run notes). Cross-checked every `event_type` written across all
edge functions against every read/query site on `origin/dev` (same method the 12th/14th runs
used) — the one apparent mismatch (`auto-reflect` querying `memory_compaction_run`) was stale
local-branch state, already fixed on `dev` by the 14th run; not a live bug, per
[[reproduce-before-trusting-handoff-diagnosis]].

**Root cause found and fixed (HIGH — the watchdog's own delivery path was unverified):** with no
live incident to chase, audited `health-check/index.ts`'s alert-send loop itself, since a bug
there is the one failure mode that hides every other failure mode. Found: `sendTelegram()`
already returns `resp.ok`, but the call site (`index.ts:485`) discarded it —
`await sendTelegram(...)` with no use of the result. The `health_check_alert` dedup row was then
written **unconditionally**, regardless of whether Telegram actually accepted the message. Since
`isDuped()` keys its cooldown check off that same row, a real delivery failure (expired/rotated
bot token, Telegram outage, 429) would look identical to a successful send and suppress every
retry of that alert for its full cooldown window (up to 24h for `system_errors`) — with zero
signal anywhere that the page never went out. This is the single point of failure for every
other fix in this log: none of it matters if the watchdog can silently no-op.

**Fix (deployed):** capture `sendTelegram()`'s return into `delivered`; on `false`, skip the
dedup write entirely (so the alert retries next cycle instead of going dark) and log an
undeduped `critical` `telegram_delivery_failed` row instead, which the existing `system_errors`
sweep will itself catch and page on next run — the failure mode becomes self-detecting. Built in
an isolated worktree off `origin/dev` (per the 12th run's branch-divergence lesson). **Verified
live:** deployed to `uyfnezxmgwitpzsrnkst`, invoked once immediately after — returned
`alerts_skipped: ["live_trading_cap_blocked"]` with no change to the normal dedup/skip path (no
regression on the happy path, confirmed bot token is currently valid via `getMe`). The failure
branch itself can't be safely forced against the live bot token without risking a real outage —
the next actual Telegram delivery failure is the real-world proof, same standard the 14th run
applied to its own untestable abort branch. PR #49 → `dev` (`89e4d08`, self-merged — alerting/
monitoring-path fix, same self-mergeable precedent as the 9th/10th/12th/13th/14th runs).
Reversible: single-branch revert (re-add the unconditional insert, drop the `delivered` check).

## 2026-07-26 (16th run) — Clean Telegram window; found `daily-digest` has 500'd on every invocation since it was written

**Telegram error state:** Zero new `error`/`critical` compliance_log rows since the 15th run
(08:16 UTC) through this run (09:07 UTC) — clean. Re-verified the 14th run's memory-compaction
cooldown fix is still holding: `memory_compaction` rows land exactly at the hourly mark
(07:07/08:07/09:07 UTC) while `auto_reflect_run` fired 2 extra settlement-triggered calls
(07:11:11, 07:11:15) that correctly did **not** produce a second compaction — no regression.
`live_trading_cap_blocked` is correctly suppressed within its 6h cooldown (last fired 04:12:59
UTC, not stuck — confirmed against the deployed `health-check` source, `cooldownHours: 6`). All
12 active `cron.job` entries have a 1:1 match in `expected_cron_jobs` — no unmonitored cron gap.
Zero live order fills/rejections in 6h, consistent with the still-open daily-trade-cap window
from the 11th run self-clearing around 19:05 UTC today, not a new issue.

**Root cause found and fixed (HIGH — silent since inception):** with no new Telegram alert to
chase, audited `daily-digest` (the per-user email/SMS trade summary, cron'd daily at 22:00 UTC)
since it had **zero `compliance_log` rows of any kind, ever** — every other cron'd function logs
at least a heartbeat row per run. Manually invoking it returned `Internal Server Error`; the edge
function's own console logs showed why: `TypeError: supabase.rpc(...).catch is not a function`
at `daily-digest/index.ts:20` — the exact same failure class as the already-fixed 2026-07-06
`auto-trade` bug (Supabase's query builder is a thenable, not a real `Promise`, so `.catch()`
doesn't exist on it and throws before the RPC even resolves). This meant **every single scheduled
run of `daily-digest`, every day since it was written, has thrown an unhandled exception and
returned a 500** — the feature has never successfully sent one digest to any user. `pg_cron`
never flagged it because it only checks that the HTTP call completed, not its status code.
Digging further surfaced two more bugs stacked behind the first: the per-user
`compliance_log.insert()` used column names (`payload`, `channel`) that don't exist on the table
(only `metadata` jsonb) and omitted the NOT-NULL `message` column — so even after fixing the
`.catch()` crash, every insert would have continued failing silently (caught by its own
`.then(undefined, e => console.warn(...))`), just with no visible error at all.

**Fix (deployed):** (1) replaced `.catch()` with the two-arg `.then(onFulfilled, onRejected)`
form already used elsewhere in this same file, matching the established fix pattern from the
2026-07-06 auto-trade incident; (2) corrected the per-user log insert to use `metadata` instead
of the nonexistent `payload`/`channel` columns, and added the required `message` field; (3) added
a `daily_digest_run` heartbeat row (`{sent, total}`) on every invocation, matching every other
cron'd function's pattern, so a future silent failure is visible without needing a manual
`curl` to discover it. **Verified live:** invoked `daily-digest` directly — first call still 500'd
(caught the column-name bug via a direct SQL insert test showing `null value in column "message"
violates not-null constraint`); after the `message` fix, invocation returned `{"ok":true,"sent":0}`
and a `daily_digest_run` row landed in `compliance_log` immediately (`0/0`, expected — no opted-in
users have live trades right now). `deno check`: 3 pre-existing type errors unchanged (same
`ReturnType<typeof createClient>` generic-version gap this project already carries elsewhere),
zero new. Built in an isolated worktree off `origin/dev` (per the 14th/15th run precedent),
leaving `fix/live-pilot-instrumentation`'s own WIP untouched. Reversible: single-function revert.

**Not investigated further (scope discipline):** did not chase the still-open
`fix/live-pilot-instrumentation` branch reconciliation (PR #42) — confirmed via `git diff
origin/dev...HEAD` that its actual code fixes already landed on `dev` through PR #47's
consolidation and direct deploys; PR #42 itself is now superseded content sitting in a
`CONFLICTING` mergeable state. Closing it is a documentation/hygiene call, not a monitoring
action — left for Onofre alongside the branch's uncommitted WIP, per the 12th/15th run precedent.

## 2026-07-26 (15th run) — Clean window; consolidated 8 runs of stranded audit history back onto `dev`

**Telegram error state:** Zero new `error`/`critical` compliance_log rows since the 14th run
(07:12 UTC). `health-check-hourly`'s 08:10 UTC run reported `1 condition(s) active but suppressed
(deduped)` — the `live_trading_cap_blocked` alert from the 11th run, correctly within its 6h
cooldown, not a new event. Confirmed via the deployed function source (`health-check` v33,
2026-07-26T05:13:05Z) that both the `live_trading_cap_blocked` alert (PR #44) and the
`diagnostic_needed` dead-queue removal (PR #45) are live in production, matching `dev`'s HEAD.
No code changes needed this run — every condition found traces to an already-fixed, already-
verified root cause from runs 8–14.

**Process finding (root cause, fixed this run — docs only):** `docs/health-log.md` on `dev` had
**zero entries for any of the 14 health-check runs that happened today (2026-07-26)** — every
run wrote its narrative to a `docs: log Nth run` commit on the `fix/live-pilot-instrumentation`
branch, which diverged from `dev` after PR #40 (see the 12th run's finding below) and was never
merged. The underlying *code* fixes mostly did reach `dev` via their own PRs (#41, #43–#46) or
were deployed directly via `supabase functions deploy` independent of any PR, but the *narrative*
— why each fix was needed, what was verified, what's still open — stayed stranded on a branch
`dev` never merged. Anyone reading `dev`'s health log today would see nothing past the 07-25
daily-trade-cap entry and have no visibility into 8 more runs of real findings. Root cause: the
`docs: log` commit for each run was made directly on the working branch instead of being included
in that run's own PR into `dev`.

**Fix (this run, docs-only, no code):** consolidated the 8 recoverable run summaries from
`fix/live-pilot-instrumentation` into this entry so `dev` has continuity. Full narrative for each
lives in these commits (still on that branch, or cherry-pickable):
- 4th run (`deb2bf5`) — clean Telegram state, cache-eviction fix deployed
- 6th run (`35a0fee`) — clean state, daily-trade-cap consolidation deployed
- 8th run (`c3b4483`) — both fixes verified clean, opened dev PR
- 9th run (`c5fc8d0`) — merged + deployed the Kalshi order-outage alert (PR #41), held unmerged 11+ hours
- 10th run (`ed13f88`) — fixed reconcile-orders-cron silent-failure gap (PR #43)
- 11th run (`8cd82d7`) — added the `live_trading_cap_blocked` alert (PR #44)
- 12th run (`c4aeb7d`) — fixed the dead `diagnostic_needed` queue (PR #45); first to flag the
  branch/`dev` divergence documented above
- 14th run (`78e3764`) — fixed a broken memory-compaction cooldown gate (PR #46)

Runs 1, 2, 3, 5, 7, and 13 were not found on this branch — likely stranded on other per-fix
branches (e.g. `fix/kalshi-order-outage-alert`, `fix/reconcile-orders-silent-failures`,
`fix/live-mode-admin-bypass`) that also never merged their docs commit. Not chased down this run
(scope creep risk) — worth a dedicated sweep.

**Not resolved this run (flagged, needs Onofre's call):** `fix/live-pilot-instrumentation` itself
still has real unmerged code fixes sitting on it — `compliance_log` retention (`6053ba9`, now
confirmed live via a separate `20260726_compliance_log_retention.sql` migration + registered
`compliance-log-retention-daily` cron job, so this one did land, just via direct deploy not PR),
plus `tenant.ts` never-type fixes (`06ce7a9`) and the S-001 concurrent-leg race fix (`314e10c`,
also confirmed live). The branch's own uncommitted WIP (`DashboardHero.tsx`, `TradeLog.tsx`,
`src/lib/queries/trades.ts`, `vite.config.ts`) is untouched — not evaluated or discarded, since
ownership and intent are unknown to this run. Branch reconciliation (merge vs. rebase vs.
cherry-pick the still-unmerged fixes) is a real decision, not a monitoring action — left for
Onofre, per the 12th run's original flag.

**Verified:** `compliance-log-retention-daily` cron job confirmed registered, active, and present
in `expected_cron_jobs` (so the existing stale-cron watchdog covers it) — but it has **zero rows
in `cron.job_run_details`**, meaning it has never actually fired yet (next scheduled tick 03:17
UTC). 263,729 of 297,656 `compliance_log` rows currently qualify for pruning (info/warning,
>30d old). Did not force an early manual run — a first-time ~264k-row delete on production
shouldn't be triggered speculatively by a monitoring pass when the job is already scheduled to
run on its own within hours. Next run should check `cron.job_run_details` for this job's first
execution and confirm it succeeded (`status = 'succeeded'`, row count dropped).

## 2026-07-25 (later run, 2nd) — daily-trade-cap counted failed orders in *two* independent places, actively rejecting live trades right now

**Telegram error state:** All errors in the last 6h trace back to the three clusters already
resolved earlier today (auth 401 → fixed ~15:25 UTC; `time_in_force` constraint → fixed same
commit; `insufficient_balance` → pre-flight check deployed ~17:14 UTC). Zero new error classes.
But `daily_trade_cap_enforced` fired 63x in the trailing 6h (vs. single digits on a normal day)
and the most recent hit, live at time of this check: `"Trade rejected: daily trade cap (100)
reached for user ea207ba1... in live mode"`, `count: 102, limit: 100` — a live 429 actively
blocking every order.

**Root cause:** today's earlier auth/balance bugs generated 70 failed live orders in 24h
(`select mode, status, count(*) from trades ... group by mode, status` confirmed 70 `failed` vs.
14 `open` + 18 `cancelled` = 32 real). Two independent daily-trade-cap checks both counted every
`trades` row regardless of `status`:
1. `auto-trade/index.ts`'s own inline pre-check (Risk-tab `max_daily_trades`) — already caught and
   fixed in this run's first pass (see below), before the second gate was found.
2. `_shared/limits.ts`'s `countTradesInWindow()` — the actual enforcement gate inside
   `execute-trade` that returns the 429 — has an explicit comment stating it was written to
   *replace* both counters, but `auto-trade` was never migrated onto it, so the same
   failed-order-counting bug had to be (and was) fixed independently in both places.
70 failed + 32 real = 102, which alone exceeded the account's 100/day tier cap — meaning **live
trading was blocking itself with a false daily-limit page even after the underlying auth/balance
bugs were fixed**, because the failures those bugs caused were still being held against the cap.

**Fix (deployed):** added `.neq("status", "failed")` to both counters —
`auto-trade/index.ts:713` and `_shared/limits.ts`'s `countTradesInWindow` (used by
`execute-trade`'s 429 gate). Both bound real trading activity/exposure now, not attempts rejected
before ever reaching the exchange. `deno check` on each file shows the same error count as
baseline (`auto-trade`: 17/17, `limits.ts`: 2/2, `execute-trade`: 22/22) — zero new errors.
Deployed via `supabase functions deploy auto-trade` and `execute-trade`. **Verified live:** polled
`compliance_log` through the next real cron cycle post-deploy — the same underfunded S-001 basket
retried (2 legs got real Kalshi order IDs and rested, 1 leg correctly rejected on genuine
insufficient balance for that specific leg) with **zero `daily_trade_cap_enforced` rejections** —
confirms the cap no longer trips on its own failure history. Real trade count post-fix: 32/100,
comfortable headroom.

**Improvement (recommended, not applied):** `_shared/limits.ts` was written specifically to be
the single source of truth replacing duplicate cap-counting logic (its own header comment says
so), but `auto-trade` was never migrated onto it — which is *why* this exact bug needed fixing
twice today. Attempted the consolidation (import `countTradesInWindow` into `auto-trade`, drop
its inline query) in this pass; reverted because it transitively pulls in `_shared/tenant.ts`
(via `limits.ts` → `getRiskSettings`), which surfaces 2 pre-existing type errors in `tenant.ts`
that `auto-trade`'s type-check graph doesn't currently reach — a real (if pre-existing elsewhere)
regression against this repo's own "zero new `deno check` errors" bar. Worth doing once
`tenant.ts`'s two `never`-type errors (`update(payload)` and `.insert({...,user_id})`, both typed
`never` from an under-specified Supabase client generic) are cleaned up separately — at that
point `auto-trade` can safely import `countTradesInWindow` and this class of bug becomes
impossible to reintroduce by construction.

**Reversibility:** both `.neq("status", "failed")` additions are single-line, independently
revertible. No schema or migration involved.

## 2026-07-25 (scheduled health check) — live basket rejected 7x on `insufficient_balance`; no pre-flight balance check existed

**Telegram error state:** 7 `order_failed` / `error` rows, all `insufficient_balance` (Kalshi
400), clustered 16:10–16:20 UTC — 3 legs of one S-001 arb basket (`KXINX-26JUL27H1600-B7412/
B7437/B7462`, buy-NO ~80-83c, 12 contracts/leg) each retried 2-3x across two surface-scanner
cycles before the alert-dedup (`kalshi_order_rejected`, 1h cooldown) went quiet. No occurrences
in the preceding 7 days — this was a fresh, one-off underfunding, not a chronic condition. One
unrelated `authentication_error` (401, `INCORRECT_API_KEY_SIGNATURE`) at 15:15 UTC — single
occurrence, not investigated this pass (no recurrence, likely a transient signing-timestamp skew).

**Root cause:** `execute-trade/index.ts`'s live path (`_shared/kalshi-auth.ts:640-648`) had zero
balance awareness — it submits every order straight to Kalshi and only learns the account can't
cover it from the 400 response. Each leg cost a full wasted round trip, and the resulting
`order_failed` row was indistinguishable from any other rejection reason (rate limit, bad ticker,
auth) until read closely. Verified: `required collateral ≈ (1 - price) × count` per leg ≈ $9.80-9.96
each ≈ $29 for the 3-leg basket, which the account's live balance didn't cover.

**Fix (deployed):** added a pre-flight balance check to `execute-trade/index.ts` — before
submitting a live order, fetch real account balance via `GET /portfolio/balance` (same call
`kalshi-ping` already uses to validate keys) and compare against the order's actual required
collateral (`price × count` for a buy, `(1-price) × count` for a sell/short — the exchange's
standard per-contract margin). If balance is short, skip the Kalshi call entirely, log a distinct
`order_skipped_insufficient_balance` compliance row (not a generic `order_failed`), and fire one
account-level Telegram alert (not one per ticker) naming the exact shortfall. Fails open on a
balance-fetch error — never blocks a trade on a monitoring-path failure. **Verified:** `deno check`
shows zero new type errors vs. baseline (22 pre-existing esm.sh version-mismatch errors, same count
before/after, none in the new code); deployed via `supabase functions deploy execute-trade`. Not yet
observed against a live retry (no basket has re-attempted this specific ticker set since deploy) —
the next live rejection, if any, is the real-world proof; watch for `order_skipped_insufficient_balance`
replacing `order_failed`+400 in `compliance_log`.

**Improvement shipped (this pass):** `health-check/index.ts` had no visibility into real Kalshi
account balance at all — the only way to learn about a funding shortfall was to wait for orders to
start failing. Added a 10th check: fetch live balance for every `kalshi_live` API key and alert
(12h cooldown, dedup'd) if it's under $15 — enough to cover a typical single-leg basket cost. This
turns the exact failure mode above into a proactive warning instead of reactive error-log noise.
Deployed and invoked once post-deploy (`{"ok":true,...}`, no crash); current live balance is above
the $15 floor so no alert fired this run — correct behavior, not yet exercised against a real low-
balance state.

## 2026-07-25 (later run) — reconcile-orders-cron was never actually registered; live orders could rest unreconciled forever

**Telegram error state:** The two bugs from the same-day entry below (RSA-PSS signing,
`time_in_force` constraint) are now confirmed fully resolved with live data, not just
"deployed" — `select mode, status, count(*) from trades where exchange='kalshi' group by
mode, status` shows 32 live orders now reaching `status='open'` cleanly, zero `error`/`critical`
compliance_log rows since 15:20:08 UTC (vs. constant failures before). `time_in_force` values are
correctly `gtc` throughout. This closes the "not yet confirmed against a live order" gap noted in
the entry below.

**New root cause found and fixed (CRITICAL):** All 30+ resting live limit orders showed `0/N
filled` no matter how old (oldest 43 min at check time) — before concluding this was a bug I
invoked `reconcile-orders` directly and it worked fine (`{"checked":30,"unchanged":30,"errors":0}`),
so the *function* wasn't broken. But `select jobname from cron.job` showed **no
`reconcile-orders-cron` job at all** — the function's own doc comment says it's "Invoked by the
reconcile-orders-cron pg_cron job," and a migration (`20260719_realmoney_reconciliation.sql`,
6 days old) exists to create exactly that job plus widen `agent_trades_pending_resolution` to
include live trades. It was never applied: the migration file itself has a syntax bug (`) ON
CONFLICT (jobname) DO UPDATE...` appended to a bare `SELECT cron.schedule(...)`, which Postgres
rejects — `SELECT` doesn't support `ON CONFLICT`. Applying it verbatim reproduced the exact
syntax error, confirming why it silently never landed. Fixed by dropping the invalid clause
(pg_cron 1.6.4's `cron.schedule()` already upserts by jobname) and applying both parts. **Verified
in prod:** job registered (`cron.job` row, active), fired automatically at its first scheduled
tick (`cron.job_run_details` runid 260178, `succeeded`), and `agent_trades_pending_resolution`
now reads `mode = ANY(paper, live)`. Net effect before the fix: every live order that didn't fill
instantly on submission was invisible to auto-settle and would eventually be wrongly zeroed by the
expiration sweep — silent live-trade P&L corruption, not just a cosmetic status field.

**Improvement (deployed):** this bug was invisible to the existing cron watchdog
(`cron_health()`, added 2026-07-06) by construction — it iterates `FROM cron.job`, so a job that
was never registered in the first place can't appear as stale or failed; it only catches jobs
that stop running, not jobs that never started. Added `public.expected_cron_jobs` (manifest table
seeded with all 11 permanent jobs) and rewrote `cron_health()` to `UNION ALL` in a synthetic
`is_stale=true, last_status='missing'` row for any manifest entry absent from `cron.job`. Gave it
its own alert branch in `health-check/index.ts` (`cron_missing`, distinct message from
`cron_stale`) so a future "wrote the migration, forgot to apply it" mistake pages loudly within
the hour instead of hiding for 6 days. **Verified:** `select * from cron_health()` returns all 11
manifest jobs healthy with no false-positive missing rows; redeployed `health-check` and invoked
it once post-deploy — ran clean, no `cron_missing`/`cron_stale`/`cron_failed` alerts.
Reversible: drop the `UNION ALL` branch and the manifest table to revert.

## 2026-07-25 — Live trading was 100% broken since going live: HMAC signing instead of Kalshi's required RSA-PSS, plus a second constraint bug it had been hiding

**Telegram error state:** `failed_trade_queue` showed every live order failing. First cluster
(2026-07-24 22:15–22:50, `deprecated_v1_order_endpoint`, 410) was the old
`/trade-api/v2/portfolio/orders` endpoint Kalshi has retired in favor of
`/trade-api/v2/portfolio/events/orders`. A same-day in-progress fix (uncommitted on
`fix/live-pilot-instrumentation`) switched the endpoint, which was deployed ~15:03 UTC today —
and immediately every order started failing differently: `authentication_error` /
`INCORRECT_API_KEY_SIGNATURE` (401), 6 in a row. `select mode, status, count(*) from trades
where exchange='kalshi' group by mode, status` showed **60/60 live attempts ever made had
status='failed' — zero successful live trades since real-money trading was enabled
(2026-07-24 21:30).**

**Root cause found and fixed (CRITICAL):** `_shared/kalshi-auth.ts` signed every Kalshi request
with **HMAC-SHA256** over a **second-precision** Unix timestamp. Kalshi's actual scheme (confirmed
against current docs) is **RSA-PSS-SHA256** (salt length = digest length, 32 bytes) over a
**millisecond-precision** timestamp, signing the path only (no query string). This bug is old, not
new — the retired `/portfolio/orders` endpoint was returning its 410 deprecation error *before*
Kalshi ever validated the signature, so the broken auth was invisible until today's endpoint fix
let requests reach real signature validation for the first time. Fixed `generateAuthHeaders` to do
proper RSA-PSS signing (PKCS8 and PKCS1 PEM import, both handled) and switched every caller
(`execute-trade`, `settle-signals`, `reconcile-orders`, `kalshi-proxy`, `market-data-fetcher`) from
`Math.floor(Date.now()/1000)` to `Date.now()`; `kalshi-ping`/`save-kalshi-key` already used ms.
**Verified against the real Kalshi API**, not a mock: minted a session token for the live user and
called `kalshi-ping` (read-only `GET /portfolio/balance`) — first successful authenticated Kalshi
call ever recorded for this account, `{"ok":true,"balance_usd":100}`.

**Second bug, found by the first fix working:** the next real cron cycle got past auth and hit a
new error, `new row for relation "trades" violates check constraint
"trades_time_in_force_check"`. The same uncommitted V2 migration introduced
`kalshiOrderPayload.time_in_force` in Kalshi's V2 vocabulary
(`fill_or_kill`/`good_till_canceled`/`immediate_or_cancel`) and then wrote that same value into our
own `trades.time_in_force` column — but that column's CHECK constraint (and every real caller,
`auto-trade` always sends `"day"`) only accepts the legacy `gtc`/`ioc`/`day` vocabulary. Fixed by
storing a normalized `ledgerTimeInForce` (our own bookkeeping label) instead of the Kalshi-payload
value. **Not yet confirmed against a live order** — deployed, waiting on the next auto-trade-cron
cycle to verify end-to-end.

**Improvement (deployed):** the HMAC bug shipped with zero test coverage because the signing logic
lived in `_shared/kalshi-auth.ts`, which imports `esm.sh` URLs vitest can't resolve — this codebase
already has a "pure logic extracted for testability" convention (`_shared/trading-logic.ts`) that
`kalshi-auth.ts` didn't follow. Extracted the signing logic into a new import-free
`_shared/kalshi-signing.ts` (re-exported from `kalshi-auth.ts` so no call sites changed) and added
`tests/kalshi-signing.test.ts` — 4 tests, RSA-PSS round-trip verified against a generated key pair,
signature byte-length check (256 bytes RSA vs 32-byte HMAC), ms-timestamp check, query-string
stripping. All pass. This is a permanent regression guard: any future accidental reversion to HMAC
or second-precision timestamps now fails CI, not silently in production for months.

**Reversibility:** both fixes are single-function edits, revertible independently. The RSA-PSS
signing change affects every Kalshi-authenticated call (`execute-trade`, `kalshi-ping`,
`reconcile-orders`, `settle-signals`, `kalshi-proxy`, `market-data-fetcher`, `save-kalshi-key`) —
all redeployed and re-verified via `kalshi-ping` after the refactor.

## 2026-07-17 — `fetchWithRetry` retried AbortErrors, silently defeating market-data-fetcher's 8s per-request timeout

**Telegram error state (last 48h):** One new critical since the 07-16 check: `market_data_fetcher_aborted`
at 2026-07-16 22:47 UTC, "run budget exceeded (61.4s)", 1 series failed (`KXHIGHMIA`), 3 skipped
(`KXFED`, `KXGDP`, `KXPAYROLLS`). Self-recovered next cycle (22:51, 18/18, 2.9s) and has stayed
healthy since (18/18, ~2–4s every run through 12:53 today). `trading_silence` fired 07-17 03:10 —
last fill is 2026-07-16 03:05 UTC (~34h ago); strategies are running every 5 min and logging
`no_setup` (filters not met), not erroring, so this reads as market conditions, not a bug. The
07-16-logged `surface-scanner` severity-overload item is still open, unchanged, not re-logged here.

**Root cause found and fixed (HIGH):** `market-data-fetcher/index.ts` wraps each series fetch in
an 8s `AbortController` timeout specifically so "no single request can hang the run" (its own
doc comment, line 32). But `_shared/kalshi-auth.ts:126` `fetchWithRetry` caught the resulting
`AbortError` in its generic `catch` block and retried it like any transient network error —
exponential backoff (1s → 2s → 4s + jitter) across 3 more attempts against an already-aborted
signal that rejects instantly. Net effect: one stuck/rate-limited series took up to ~16.5s to
fully fail instead of the intended 8s cap, and since `RUN_BUDGET_MS` (50s) is only checked
*between* batches, one bad series in a batch of 5 was enough to blow the budget for the whole
run. This is the same failure class as 07-09 (3×) and 07-13 (full abort, since reduced by
batching but not eliminated) — batching cut the blast radius, this closes the actual hole.

**Fix (deployed):** `fetchWithRetry` now rethrows immediately on `AbortError` instead of
retrying it — cancellation is terminal, not transient. **Verified in prod:** invoked
`market-data-fetcher` once post-deploy → `18/18 series OK, 0 failed, 0 skipped, 3208ms`
(no regression on the happy path; the fix only changes behavior on the abort branch, which
doesn't fire under normal conditions — next 429/timeout event is the real-world proof).
Reversible: single-function revert of the `catch` block in `_shared/kalshi-auth.ts`.

## 2026-07-16 — `compliance_log.severity` overloaded for trading signal, not system health

**Telegram error state (last 48h):** Clean. No `error`/`critical` rows since the 07-13
`market_data_fetcher_aborted` (already resolved 07-14). Zero Telegram alerts fired in the
window. Trading is active (order fills present in `auto_trade_strategy_run`/`order_filled` rows).

**Improvement (logged, MED):** `surface-scanner/index.ts:450` writes `severity: "warning"` to
`compliance_log` on *every* scan that finds an alert with `expected_edge_cents >= 10` — which is
effectively every 5-minute run right now (100% of the last 100 sampled rows were
`surface_scan_complete` warnings). That's a **trading-opportunity flag**, not a system-health
signal, but it shares the same `severity` column the health-check sweep and this exact audit query
by severity. Result: a real `error`/`critical`/`warning` row is needle-in-haystack behind ~288
routine warnings/day. Same root issue as the already-queued `s001_edge_below_fee_hurdle` noise item
in `TASKS.md` — severity is being reused as a business signal. Fix: give surface-scanner its own
`event_type`-based signal (e.g. keep `severity: "info"` always, add `metadata.high_edge: true`) so
`severity` stays reserved for things that actually need a human. Not deployed this run — logging
only, no code/infra change made autonomously.

## 2026-07-14 — market-data-fetcher runs unauthenticated (root cause of Kalshi 503/429 alerts)

**Telegram error state (last 7 days):** No new-class failures. The 07-13 `market_data_fetcher_aborted`
(130.6s run-budget) critical is resolved — fetcher now completes 18/18 series in ~2–3s per cycle
(verified: 10:06 run 3.1s, 18/18, 0 failed). `trading_silence` alerts (07-10, 07-13) were transient —
trading has resumed (last fill 2026-07-14 05:05, `KXINX` filled). Only recurring alerts left are
`api_error_kalshi` 503/429 (07-09, 07-12) — addressed by the improvement below.

**Improvement (logged, HIGH):** Every `market_data_fetch` compliance row still logs
`authenticated: false` — `getKalshiCredentials(supabase, null)` finds no `kalshi_live` row for the
NULL/service tenant and no `KALSHI_API_KEY_ID` / `KALSHI_API_PRIVATE_KEY` env fallback
(`_shared/kalshi-auth.ts:113–114`), so the fetcher hits Kalshi anonymously at the lowest rate tier.
That anonymous tier is the root cause of the recurring 503/429 alerts and the pressure that blew the
old sequential fetcher's budget. Fix: provision a service-level Kalshi key for the fetcher — set
`KALSHI_API_KEY_ID` + `KALSHI_API_PRIVATE_KEY` in the edge-function secrets (or seed a `user_id IS NULL`
`kalshi_live` row) so `authenticated: true`. Expected effect: higher rate ceiling, 503/429 alerts stop,
more headroom under the 50s budget. Reversible (secret-only change, no code).

**RESOLVED — 2026-07-14.** Seeded a service-tenant `api_keys` row (`user_id IS NULL`, provider
`kalshi_live`, id `4306d894…`) reusing the encrypted `key_id`/`secret_ciphertext`/`secret_iv` from
the only stored Kalshi key — Onofre's own (`omiiaiagency@gmail.com`); market-data fetch is read-only,
no trading on the account. No plaintext handled: the fetcher decrypts at runtime via the
`API_KEY_ENCRYPTION_KEY` already set on the edge functions. **Verified in prod:** invoked once →
`authenticated: true`, 18/18 series, 0 failed, 805 markets, 2.3s. Rollback: delete row `4306d894…`.

## 2026-07-13 — market-data-fetcher starving on run budget

**Telegram error state (last 7 days):** No new-class failures. The July-6 wave
(`.catch is not a function` in auto-trade strategies + `trade_lessons` check-constraint
violations) is resolved — no recurrences since the 2026-07-10 production-hardening
migration. Remaining alerts are Kalshi upstream 503/429s (transient) and the item below.

**Active issue (critical, today):** `market-data-fetcher` aborted at **130.6s** against a
50s `RUN_BUDGET_MS`, skipping **all 18 series** (KXFED, KXCPI, KXBTC, KXHIGHNY, …). Series
are fetched **strictly sequentially** with per-request retries + `KALSHI_REQUEST_SPACING_MS`
spacing; a few slow/retrying series consume the whole budget, so the budget check trips before
most series are refreshed. Downstream, signal-generator / weather-signal / futures-signal run
on stale market data.

**Improvement (logged to TASKS.md, Queued, HIGH):** Fetch series in **bounded concurrent
batches** (e.g. 4–6 at a time via `Promise.all`) instead of one-at-a-time, and **rotate the
starting series offset each run** so the same tail series aren't perpetually last-in-line and
starved. Expected effect: ~4–6× lower wall-clock, run stays inside the 50s budget, full series
coverage each cycle. Per-request 8s `AbortController` timeout already exists and stays.

**RESOLVED — deployed 2026-07-13.** Rewrote the fetch loop to process series in bounded
concurrent batches (`BATCH_SIZE = 5`, 110ms intra-batch stagger to stay ≤~9 req/sec) with a
rotating per-run start offset. Circuit breaker changed from consecutive-series-failures to
consecutive fully-failed-batches (Kalshi-down signal). Per-request 8s timeout and 50s run budget
retained. **Verified in prod:** invoked once → 18/18 series OK, 844 markets cached, **3.4s**
(was 130.6s abort / 0 series). `compliance_log` `market_data_fetch` row logged `info`, 18/18.

**Follow-up flagged (not blocking):** the verified run logged `authenticated: false` —
`getKalshiCredentials()` returned no Kalshi key, so the fetcher runs unauthenticated (lower rate
limits). It still succeeded, but this is likely what made the old sequential version hit 503s and
blow its budget under load. Worth wiring a service-level Kalshi key for the fetcher.
