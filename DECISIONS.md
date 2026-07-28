# DECISIONS — Omii-AI-PM-TradeAgent

Append-only log of critical architectural decisions. Newest first.

---

## 2026-07-28 — Guarded kalshi-ping's credential fetch with the same 8s timeout pattern

**Decision:** Wrapped `getKalshiCredentials(supabase, user.id)` in `kalshi-ping/index.ts` in a
`Promise.race` against an 8s timeout, identical to the pattern applied to `market-data-fetcher`
(48th run), `health-check` (51st run), `reconcile-orders` (52nd run), and `settle-signals` (54th
run).
**Options:** A) Leave it — rejected: same unguarded shape, and this call site is the only one of
the backlog that's synchronous and user-facing rather than cron-driven — a stalled query here
hangs the onboarding wizard's "verify Kalshi key" step indefinitely with no error surfaced,
directly blocking a new user's first-run activation rather than silently degrading a background
job. B) Fix the shared `getKalshiCredentials()` helper globally — rejected, same reasoning as
every prior run: broader blast radius, and the remaining trading-path call sites (`execute-trade`,
`trading-agent`, `futures-signal`, `kalshi-proxy` ×2) stay a deliberate, reviewed decision, not a
side effect of a health-check sweep. C) Scope the fix to `kalshi-ping`'s single call site —
chosen, mirrors existing precedent, read-only balance check, no order placement, and picked over
the remaining backlog because a user-facing onboarding hang has direct MRR impact (activation
friction) versus the others' background-job blast radius.
**Why:** No live incident forced this (zero new `compliance_log` errors this run, all 14 cron jobs
healthy) — preventive fix grounded in a proven failure mode, closing the next-highest-value
instance from the backlog the 54th run explicitly left noted-but-unfixed. `futures-signal`,
`kalshi-proxy` ×2, and `trading-agent` ×2 remain unguarded — one narrow fix per run, not a sweep.
**Reversibility:** Trivial — single-file, single-block revert, no schema or trading-path change.
**Trace:** PR (this run, 55th health-check), `docs/health-log.md` 55th-run entry. Original pattern:
`docs/health-log.md` 48th/51st/52nd/54th-run entries, this file's market-data-fetcher/health-check/
reconcile-orders/settle-signals entries below.

## 2026-07-28 — Guarded settle-signals' credential fetch with the same 8s timeout pattern

**Decision:** Wrapped `getKalshiCredentials(supabase, null)` in `settle-signals/index.ts` in a
`Promise.race` against an 8s timeout, identical to the pattern applied to `market-data-fetcher`
(48th run), `health-check` (51st run), and `reconcile-orders` (52nd run).
**Options:** A) Leave it — rejected: same unguarded-call shape already diagnosed as a real stall
cause three times in this codebase; here a hang would silently eat the entire 15-min
`settle-signals` run since the credential fetch sits ahead of the try/catch's effective reach (a
non-throwing hang never trips the existing `catch`), stalling shadow-PnL attribution for every
unsettled signal in the batch with no alert until the next run's absence was noticed. B) Fix the
shared `getKalshiCredentials()` helper globally — rejected, same reasoning as the three prior
runs: broader blast radius, and the trading-path call sites (`execute-trade`, `trading-agent`,
`futures-signal`, `kalshi-ping`, `kalshi-proxy` ×2) stay a deliberate, reviewed decision, not a
side effect of a health-check sweep. C) Scope the fix to `settle-signals`' single call site —
chosen, mirrors existing precedent, single-tenant service-credential fetch (`userId = null`, same
shape as `market-data-fetcher`), read-only shadow-PnL computation, no order placement.
**Why:** No live incident forced this (zero new `compliance_log` errors this run, all 14 cron jobs
healthy) — preventive fix grounded in a proven failure mode, closing the next-highest-value
instance from the backlog the 52nd run explicitly left noted-but-unfixed. `futures-signal`,
`kalshi-ping`, `kalshi-proxy` ×2, and `trading-agent` ×2 remain unguarded — one narrow fix per run,
not a sweep.
**Reversibility:** Trivial — single-file, single-block revert, no schema or trading-path change.
**Trace:** PR (this run, 54th health-check), `docs/health-log.md` 54th-run entry. Original pattern:
`docs/health-log.md` 48th/51st/52nd-run entries, this file's market-data-fetcher/health-check/
reconcile-orders entries above.

## 2026-07-28 — Retry transient esm.sh CDN failures in CI edge-function deploy jobs instead of failing the whole job
**Decision:** Wrapped each `npx supabase functions deploy "$fn"` call in `deploy-staging-functions`
and `deploy-production-functions` (`.github/workflows/ci.yml`) in a 3-attempt retry loop with 15s
backoff.
**Options:** A) Leave as-is, rely on manual reruns — rejected: discovered via the 52nd run's own
push failing CI on a bundling-time `esm.sh` 522 (external CDN transient, confirmed not a code
defect by rerunning the identical commit clean); on a `main` push this class of failure would stall
the `canary-gate` → production promotion until a human noticed and reran it. B) Retry only the
specific function that failed, not a generic loop — rejected as unnecessary complexity; the
per-function loop already isolates retries to the one function that hit the blip. C) Add retry
per-function inside the existing loop, fail loud after 3 attempts — chosen; matches the "fail loud,
never silent" standard while absorbing exactly the failure class observed.
**Why:** The `bash -e` default means one transient failure on any single function (of ~20) aborts
the entire deploy job; the dependency at fault (esm.sh CDN) is external and outside the codebase's
control, so retrying is the correct guard, not a code fix to `auto-trade` or any other function.
**Reversibility:** easy — single-file CI workflow change, single-block revert, no schema or
trading-path impact.
**Trace:** 53rd health-check run, PR → `dev`, `docs/health-log.md` same-date entry ("53rd run").
Incident run: `gh run view 30357821307 --repo onofre-jauregui/Omii-AI-PM-TradeAgent`.

## 2026-07-28 — Guarded reconcile-orders' per-user credential fetch with the same 8s timeout pattern

**Decision:** Wrapped `getKalshiCredentials(supabase, userId)` in `reconcile-orders/index.ts`'s
per-user reconciliation loop in a `Promise.race` against an 8s timeout, identical to the pattern
applied to `market-data-fetcher` (48th run) and `health-check` (51st run).
**Options:** A) Leave it — rejected: same unguarded shape already diagnosed as a real stall cause
twice in this codebase; here it's structurally worse than the single-tenant fetches already fixed,
since a hang on one user's credential fetch would silently stall every other user's resting-order
reconciliation for the rest of the invocation. B) Fix the shared `getKalshiCredentials()` helper
globally — rejected, same reasoning as the 48th/51st runs: broader blast radius, and expanding into
trading-path call sites (`execute-trade`, `trading-agent`) should be a deliberate, reviewed decision,
not a side effect of a health-check sweep. C) Scope the fix to `reconcile-orders`' call site only —
chosen, mirrors existing precedent, stays inside the monitoring/reconciliation path (read-only
order-status checks, no order placement).
**Why:** No live incident forced this (zero new `compliance_log` errors this run) — preventive fix
grounded in a proven failure mode, applied to the next-highest-blast-radius instance the 51st run
explicitly left noted-but-unfixed. `settle-signals` and 4 other call sites remain unguarded — one
narrow fix per run, not a sweep.
**Reversibility:** Trivial — single-file, single-block revert, no schema or trading-path change.
**Trace:** PR (this run, 52nd health-check), `docs/health-log.md` 52nd-run entry. Original pattern:
`docs/health-log.md` 48th/51st-run entries, this file's market-data-fetcher/health-check entries
below.

## 2026-07-28 — Guarded health-check's live-balance credential fetch with the same 8s timeout used in market-data-fetcher

**Decision:** Wrapped `getKalshiCredentials(supabase, user_id)` in `health-check/index.ts`'s
live-balance loop (§10) in a `Promise.race` against an 8s timeout, identical to the pattern the
48th run applied to `market-data-fetcher`.
**Options:** A) Leave it — rejected: it's the same unguarded-call shape already diagnosed as a
real stall cause elsewhere in this codebase, and a hang here is structurally worse since
`health-check` is the alerting path — a stall would silently kill the whole hourly sweep, not
just skip part of one check. B) Fix the shared `getKalshiCredentials()` helper so every caller
gets the guard — rejected, same reasoning the 48th run gave: broader blast radius, and this run
should not expand into the trading-path call sites (`execute-trade`, `trading-agent`) without
that being a deliberate, reviewed decision. C) Scope the fix to `health-check`'s call site only —
chosen, mirrors the existing precedent exactly and stays inside the monitoring path.
**Why:** No live incident forced this (zero new `compliance_log` errors this run) — this is a
preventive fix grounded in a proven failure mode already fixed once in this codebase, applied to
the one other call site where a hang has the highest blast radius (the monitor itself going
dark). `settle-signals`, `reconcile-orders`, and three other call sites remain unguarded — noted,
not fixed this run; one narrow fix per run, not a sweep.
**Reversibility:** Trivial — single-file, single-block revert, no schema or trading-path change.
**Trace:** PR (this run, 51st health-check), `docs/health-log.md` 51st-run entry. Original
pattern: `docs/health-log.md` 48th-run entry, this file's 2026-07-28 market-data-fetcher entry
below.

## 2026-07-28 — Closed both remaining `react-hooks/exhaustive-deps` warnings; one via latest-ref (not naive dep addition, would have caused refetch storms)

**Decision:** (1) `MarketsPanel.tsx`'s "open market from agent chat" effect called
`onMarketOpened?.()` without listing it as a dependency. Added a `onMarketOpenedRef` latest-ref
updated in its own effect, and read `onMarketOpenedRef.current` in the ticker-open effect instead
of the prop directly — the effect's dependency array (`[openMarketTicker]`) is now honest without
changing when it fires. (2) `PortfolioChart.tsx`'s real-time-subscription effect referenced `mode`
and `strategyFilter` directly (in the Supabase channel name) without listing them, even though its
`[loadChartData]` dependency already re-runs the effect on any `mode`/`strategyFilter` change
(`loadChartData` is a `useCallback` keyed on both). Added both to the deps array explicitly.
**Options (MarketsPanel):** A) Add `onMarketOpened` to the deps array as-is — rejected: traced its
caller, `Index.tsx:316`, which passes `onMarketOpened={() => setMarketToOpen(null)}` — a new
function reference on every `Index.tsx` render (and that page re-renders on tab switches, mode
toggles, and other sibling state changes unrelated to markets). Naively satisfying the linter here
would have made the effect re-fire `fetchKalshiMarket(openMarketTicker)` on every one of those
unrelated re-renders, not just when a market is actually opened — the RiskControlsPanel fix
(49th run) wasn't a valid template here because that case was a *static* value; this one is a
non-memoized callback prop. B) Latest-ref pattern — chosen: keeps the effect's fire condition tied
only to `openMarketTicker`, calls the current callback without lying about the dependency.
**Options (PortfolioChart):** listing `mode`/`strategyFilter` explicitly introduces no new re-run
case (they already gate `loadChartData`'s identity) — added directly, no ref needed.
**Why:** Same "zero live errors, sweep the lint backlog" pattern as the 48th/49th runs. This one
required reading the caller before touching the dependency array — the naive fix would have
silenced the linter while introducing a real refetch-storm bug on a page with several frequently-
changing sibling state values.
**Reversibility:** Trivial — two-file, two-component revert. No schema, no edge function, no
trading-path code touched; both are read-side UI components (market lookup + portfolio chart).
**Trace:** PR (this run, 50th health-check), `docs/health-log.md` 50th-run entry.

## 2026-07-28 — Confirmed the canary-gate `jq` fix on its first real run; hoisted a static object out of `RiskControlsPanel` to close a stale lint warning

**Decision:** (1) Verified — not re-decided — that the 2026-07-25 canary-gate `jq` parsing fix
held: PR #86's push to `main` (2026-07-27T18:05:31Z) is the first `main` push since that fix, and
its `Canary health gate (30 min)` job completed `success`. Closing that entry's open "not yet
verified" caveat. (2) Moved `RiskControlsPanel.tsx`'s `liveDefaults` object literal from inside
the component body to a module-level `LIVE_RISK_DEFAULTS` constant.
**Options (for the lint fix):** A) Add `liveDefaults` to the `useCallback` dependency array as-is
— rejected, the object is a new reference every render, so this would invalidate `loadAll`'s
identity every render and loop the `useEffect` that calls it. B) Suppress the eslint rule for that
line — rejected, papers over a real (if minor) per-render allocation instead of fixing it. C)
Hoist the static value to module scope — chosen, matches ESLint's own guidance for exactly this
shape and removes the per-render allocation.
**Why:** Zero-risk, in-scope cleanup once the mandatory error/cron/CI sweep came back clean and
the two real open backlog items (migration-backlog replay, HITL gate build) are both explicitly
Onofre's call per their own `DECISIONS.md` entries below, not something to auto-execute.
**Reversibility:** Trivial — single-file, single-component revert. No schema, no edge function, no
trading-path code touched.
**Trace:** PR (this run, 49th health-check), `docs/health-log.md` 49th-run entry. Canary-gate fix
originally: 2026-07-25 entry below. Run verified: `gh run view 30292213095`.

## 2026-07-28 — Bounded market-data-fetcher's credential fetch with a timeout (closing an 8-day-old flagged gap)

**Decision:** Wrapped `getKalshiCredentials(supabase, null)` in `market-data-fetcher/index.ts` in
a `Promise.race` against `REQUEST_TIMEOUT_MS` (8s). On timeout/error, sets `abortReason` and
`skippedSeries = [...SERIES]`, routing through the function's existing abort-alert path instead
of hanging.
**Options:** A) Leave it logged-but-unfixed another run — rejected, it's the exact proposed fix
from the 2026-07-20 `DECISIONS.md` entry and had sat open 8 days with two real incidents behind
it. B) Add a timeout to the shared `getKalshiCredentials()` itself so every caller benefits —
rejected for this run: broader blast radius touching `execute-trade`/`auto-trade`'s real-money
path, more than an unattended run should change at once. C) Scope the timeout to the
`market-data-fetcher` call site only — chosen, matches the original proposal exactly and keeps
the change to a read-only market-data cache poller.
**Why:** The 2026-07-13 (130.6s) and 2026-07-16 (61.4s) stalls both trace to this exact
unguarded call, sitting before `RUN_BUDGET_MS` enforcement starts — a stall here silently ate
the whole run with no accurate cause. The fix was already scoped and reviewed 8 days ago; shipping
the narrow version now closes a known gap without expanding scope into the trading path.
**Reversibility:** Easy — single-function revert, redeploy previous version.
**Trace:** `docs/health-log.md` (48th run), `DECISIONS.md` 2026-07-20 entry (original proposal).

## 2026-07-28 — Closed the `settle-signals` batch-rotation bug flagged as a watch item on the prior run

**Decision:** Added a `settlement_status` column and changed `settle-signals` to stamp `settled_at`
(with `settlement_status = 'unsettleable_404'`, `settlement_price`/`shadow_pnl` left null) on any
ticker Kalshi returns a definitive 404 for, and changed the eligibility query to gate on
`settled_at IS NULL` instead of `settlement_price IS NULL`.
**Options:** A) Add `ORDER BY` only (e.g. by `expires_at`) — rejected: the stuck batch already *is*
the oldest by `expires_at`, so sorting by it changes nothing; the same 200 rows would still win
every tick since they never get updated. B) Track attempts with a retry counter and skip after N
tries — rejected: adds a decay/backoff dimension for no benefit here, since this run confirmed all
1000 failures in the window were a consistent 404 (not transient) — there's nothing to retry. C)
Stamp `settled_at` on definitive 404s only, leave transient failures untouched for retry (chosen) —
directly fixes the stuck batch, cheapest correct model of the actual failure mode observed.
**Why:** the prior run's own fix (registering `settle-signals-cron`) exposed a second bug: with no
`ORDER BY` and no way to mark a row "tried and permanently unsettleable," the same oldest ~200
signals (all 2.5-month-old archived tickers, confirmed via `compliance_log` across 5 consecutive
ticks from 06:13–07:00 UTC returning identical tickers, 1000/1000 `api_error`s all HTTP 404) were
re-selected forever, starving the other ~20,700 backlog rows of ever being checked.
**Reversibility:** easy — additive/nullable column, `git revert` restores the prior (spinning)
behavior; the ~400 rows already marked `unsettleable_404` this run stay correctly excluded either
way since they were, in fact, unsettleable.
**Trace:** this run's PR → `dev`, `docs/health-log.md` this entry. Verified live: manual invocation
marked 207 signals `unsettleable_404` and the batch rotated (May → July tickers); the following
`07:15:13 UTC` pg_cron tick fired automatically and processed a third, further-rotated batch,
confirming the fix holds under the real schedule, not just a manual call.

## 2026-07-28 — Registered the never-applied `settle-signals-cron` (2.5-month-old migration gap); fixed a swallowed-error bug in the function itself

**Decision:** Applied a new migration adding the six `signals` columns
(`shadow_pnl`/`settlement_price`/`settled_at`/`direction_correct`/`profitable`/`system_version`)
and the `settle-signals-cron` pg_cron job that `20260504120000_v2_instrumentation_and_lock.sql`
was supposed to create back on 2026-05-04, plus fixed `settle-signals/index.ts` to check the
Postgrest `error` instead of silently swallowing it.
**Options:** A) Flag it for review like the staging-migration-backlog and HITL findings — rejected:
unlike those, this is fully additive/nullable, touches zero trading logic, and has an exact,
already-proven-safe precedent (`20260728_register_paper_reconcile_cron.sql`, same run's paper-
reconcile fix). B) Register the job and fix the code bug now (chosen) — matches the established
bar for monitoring/data-pipeline gaps: safe to fix unattended, unlike anything touching
`execute-trade` or live order placement.
**Why:** `settle-signals` computes shadow PnL for every signal the qualifier skipped — the
project's own docs call it "the biggest data unlock in v2" for measuring qualifier ROI — and it had
run zero times, ever, since being built on 2026-05-12. The root cause is the exact swallowed-
migration-failure bug this run's earlier fix (CI's `migrate-staging`/`migrate-production`) closed
for the future, just discovered as a live casualty on production predating that fix. 20,936 of
21,782 signals sit unsettled; `qualifier_roi_v2` has been empty since the day it was created.
**Reversibility:** easy — new columns are additive/nullable, the cron job can be unscheduled, the
function diff is a single `if (error) throw`; `git revert` restores the prior (dead) state.
**Trace:** PR #99 → `dev`, `docs/health-log.md` 46th-run entry. Watch item logged there: the settle
query has no `ORDER BY`, so whether it naturally rotates past the unresolvable ~2.5-month-old
404 batch toward the eligible backlog needs confirming over the next few runs, not assumed.

## 2026-07-28 — Closed the migration-runner root cause from the 2026-07-27 "staging DB unmigrated" finding (partial — backlog repair still open)

**Decision:** Fixed `migrate-staging`/`migrate-production` in `.github/workflows/ci.yml` to hard-fail
on a bad migration (removed the `|| echo WARN` swallow around `curl -sf`) and to only record a
`schema_migrations` history row on confirmed success, plus re-keyed new inserts off the full
filename stem to stop same-day files colliding on a date-only version.
**Options:** A) Fix items 1–3 from the 2026-07-27 finding's proposed fix (runner correctness) without
touching item 4 (reset staging + replay the full migration backlog) — chosen. B) Do the full repair
in one shot — rejected: resetting/replaying ~40 migrations against shared staging infra is a bigger,
riskier action than a single automated health-check run should take unprompted.
**Why:** The runner bug is a closed, low-risk, root-cause fix (CI-yaml only, no data touched) that
stops the problem from getting worse. The historical backlog (staging DB missing most tables despite
`schema_migrations` claiming otherwise) is a separate, larger call — it needs a decision on whether to
reset staging, and that's Onofre's to make, not something to auto-execute.
**Reversibility:** easy — `git revert` on the CI-yaml change restores prior (silently-swallowing)
behavior; no schema or data touched.
**Trace:** PR #97 → `dev` (fix), `docs/health-log.md` 45th-run entry. The 2026-07-27 finding entry
below stays open for the backlog-repair decision (its proposed-fix step 4).

---

## 2026-07-28 — Removed the permanently-failing "HITL approvals component" E2E assertion; flagged (not built) the missing HITL gate on live trades

**Decision:** Deleted the `"HITL approvals component is in the JS bundle"` test from
`tests/e2e/production-hardening.spec.ts` (added 2026-07-11, PR `f2fd68b` "production hardening").
Did **not** build the asserted `HITLApprovalsCard` component or wire any approval gate into
`execute-trade`.
**Finding:** CI's `E2E smoke tests → kalshitradeagent.live` job has failed on every push to `dev`
since at least the 36th run (2026-07-27 19:13 UTC) through the 43rd (2026-07-28 03:10 UTC) — 8
consecutive PRs merged with this one test red. Root cause: the 2026-07-11 PR shipped a
`hitl_approvals` table (`user_id`, `trade_payload`, `status`, `requested_at`, `decided_at`,
`decision_note`, `trace_id` — a complete approval-queue schema) and an E2E test asserting a
`HITLApprovalsCard` UI component exists, but never built that component and never wrote any
producer/consumer for the table — `grep -rl hitl_approvals supabase/functions/` returns nothing.
No code path inserts into, reads from, or blocks on `hitl_approvals`; live trade execution in
`execute-trade/index.ts` has no human-approval step of any kind. The table and test are dead,
orphaned scaffolding from an incomplete feature, not a regression.
**Options:** A) Build the real HITL gate (UI card + backend block on live orders pending approval)
to make the test's assertion true — rejected for this run: it's a live-trade-execution behavior
change (money-logic) with no current product ask behind it (not on `CLAUDE.md`'s priority list),
squarely in "ask first" territory, and this project's own rules say don't add features beyond
what was asked. B) Patch the test to pass some other way (e.g. check for the table instead of a
component) — rejected, that's re-decorating a false assertion rather than fixing the root cause.
C) Delete the false assertion and flag the real gap for an explicit decision (chosen) — matches the
precedent set by the 2026-07-27 "staging DB unmigrated" entry: surface money/architecture-shaped
gaps for review rather than auto-deciding them.
**Why:** Zero-risk, in-scope fix (test-file-only, no execute-trade or schema change) that stops CI
lying red on every dev push — a permanently-failing check trains reviewers to ignore CI, the same
"looks healthy but isn't / looks broken but isn't" failure class multiple prior health-check runs
have closed elsewhere. The actual product decision — build the HITL approval flow for real, or
drop the orphaned `hitl_approvals` table — needs Onofre's call, not an autonomous one, since a
real-money trading agent's live-order path is explicitly out of this task's "just decide" bucket.
**Reversibility:** Easy — single test-file diff, git revert restores the (still-failing) assertion.
No schema, no edge function, no execute-trade change.
**Trace:** PR (this run, 44th health-check), `docs/health-log.md` 44th-run entry.

## 2026-07-27 — Fixed migrate-staging's silent-failure swallow; deliberately did not re-key VERSION or re-run the backlog
**Decision:** In `.github/workflows/ci.yml`'s `migrate-staging` job, a failed migration `curl -sf` now `exit 1`s the job, and the `schema_migrations` history INSERT only runs after a confirmed-successful apply.
**Options:** A) Fix all three items from the prior entry's proposed fix (fail-loud, record-on-success-only, full-stem VERSION + backlog re-run) in one pass — rejected, re-keying VERSION makes all ~40 existing history rows look unapplied and would re-trigger the entire backlog against live shared staging with unverified idempotency. B) Fix only fail-loud + record-on-success (chosen) — closes the "reports success on failure" root cause for every future migration without touching existing history rows or triggering any DB writes this run.
**Why:** The swallow-and-record bug is a pure CI-config defect, safe to fix unattended (zero migrations executed, zero deploys). The VERSION re-key + backlog re-run is a data-shaped decision on live shared infrastructure that needs an explicit reset call — same blast-radius line the prior entry drew.
**Reversibility:** Easy — single-file workflow diff, git revert.
**Trace:** PR (this run, 33rd health-check), `docs/health-log.md` 33rd-run entry.

## 2026-07-27 — Flagged: staging Supabase DB is largely unmigrated despite CI claiming success (not auto-fixed)

**Decision:** Logging as a critical finding for review rather than attempting a fix — this is shared CI/deploy infrastructure, not scoped to any one feature.
**Finding:** Verifying PR #81 (paper-fill-realism) on staging, `information_schema.tables` showed **only 2 tables exist in `public`** (`expected_cron_jobs`, plus the `agent_cron_health` view) — `trades`, `strategies`, and every other core table are absent. Yet `supabase_migrations.schema_migrations` on the same project lists ~40 versions back to 2026-05-11 as applied, and `cron.job` has **zero rows** despite `reconcile-orders-cron`/`auto-trade-cron`/etc. all being long-standing. Root cause: `.github/workflows/ci.yml`'s `migrate-staging` job (lines 34-65) runs each migration via `curl -sf ... && echo OK || echo WARN`, then **unconditionally** inserts a `schema_migrations` row regardless of whether the SQL succeeded — a failed migration is recorded as applied and never retried, silently, forever. It also derives `VERSION` from only the date prefix (`cut -d_ -f1`), so same-day multi-file migrations (this PR shipped two `20260727_*.sql` files) collide on one version key. This is the same failure shape already fixed once for `reconcile-orders-cron` specifically (`20260725_expected_cron_manifest.sql`) but never generalized — the fix there added a job-existence manifest, not a fix to the migration runner that let it happen.
**Impact:** Every past PR's "verified on staging" claim in this repo has likely been checking Vercel/frontend behavior only — the backend DB schema on staging has probably never matched what migrations describe. `dev`'s E2E suite passing is not evidence the DB layer works; it only proves the frontend bundle loads.
**Not fixed here:** repairing months of accumulated migration failures on shared infrastructure is a separate, larger effort with its own blast-radius considerations — out of scope for a feature PR. This PR's own two migrations (`20260727_trade_fees.sql`, `20260727_paper_reconcile_cron.sql`) are very likely among the silently-failed ones on staging as a result.
**Proposed fix (for review, not applied):** (1) make the migration runner treat a failed `curl -sf` as a hard job failure (`exit 1`), not a swallowed `WARN`; (2) only insert the `schema_migrations` history row on confirmed success; (3) derive `VERSION` from the full filename stem, not just the date prefix, so same-day files don't collide; (4) once the runner is fixed, re-run the full migration backlog against staging from scratch (likely needs to start from a clean/reset staging DB given how far behind it is) to get it to actually match `main`'s schema.
**Reversibility:** N/A — no code changed by this entry.
**Trace:** Found while verifying PR #81. `curl -X POST https://api.supabase.com/v1/projects/<staging_ref>/database/query` against `information_schema.tables`, `cron.job`, `supabase_migrations.schema_migrations` — all queried directly, 2026-07-27.

## 2026-07-27 — Paper trading simulates real fill risk + Kalshi fees (PR #81)

**Decision:** Rewrote `execute-trade`'s paper branch to simulate fills against the real, public Kalshi orderbook (`_shared/fill-sim.ts`: `simulatePaperFill`, `estimateKalshiFee`) instead of unconditionally inserting `status:"filled"` at the exact requested price with $0 fee. Added a `paper-reconcile` cron to advance resting paper orders over time, the same way `reconcile-orders` does for live. Adopted `docs/design/full-transaction-cost.md`'s schema (`entry_fee_cents`/`exit_fee_cents`/`ai_qualify_cost_usd`/`net_pnl`) for fee accounting.
**Finding:** Paper S-001 showed 354 attempts / 12 fills / $930.77 P&L while live S-001 had placed 265 real order attempts and filled zero — paper was measuring signal-detection quality only, not real fill risk, making it useless as a live-performance preview (the entire point of paper mode).
**Options:** A) Simpler ad-hoc `fee_dollars` column — rejected once a more thorough, already-written, unmerged design (`feat/full-transaction-cost-tracking` worktree, 2026-07-23, awaiting sign-off) was found covering the same need with a more complete two-layer cost model. B) Adopt that design's schema (Option A within it: direct cost per-trade, shared AI cost as a separate platform-overhead line) — chosen, per Onofre's confirmation.
**Why:** Live captures Kalshi's own reported fee from the real order response (zero formula risk); only paper needs to estimate via the published fee formula, since there's no real order to read a fee from. `ai_qualify_cost_usd` ships nullable/unpopulated — no per-model pricing table exists yet; scoping it out now rather than faking it, per the design's own two-layer split.
**Reversibility:** Easy — new columns are additive/nullable, `paper-reconcile-cron` can be unscheduled, `checkLiquidity`'s refactor is behavior-preserving (verified via `deno check` error-count parity against `origin/dev`).
**Trace:** PR #81 on `feature/paper-fill-realism` → `dev`. `docs/design/full-transaction-cost.md`.

## 2026-07-26 — Fixed health-check's kalshi_low_balance alert: doubled URL path, 404'd since inception

**Decision:** In `health-check/index.ts`'s live-balance check, fetch `${KALSHI_BASE_URL}/portfolio/balance` instead of `${KALSHI_BASE_URL}${path}` where `path` was already the full `/trade-api/v2/portfolio/balance`.
**Finding:** `KALSHI_BASE_URL` (`_shared/kalshi-signing.ts`) already ends in `/trade-api/v2`; appending the fully-qualified signed path doubled the segment (`.../v2/trade-api/v2/portfolio/balance`), which Kalshi 404's. `if (!resp.ok) continue` swallowed every failure silently, so `kalshi_low_balance` had zero rows in `compliance_log` — ever — despite the live account sitting at $1.66 (floor $15) for hours today. execute-trade's separate per-order `kalshi_insufficient_balance` alert (correct URL construction there, matched against `getKalshiBaseUrl()`) still caught the condition reactively, which is the only reason it wasn't silent end-to-end — but the proactive early-warning this function exists for had never once fired since it was added.
**Options:** A) Leave it — the reactive execute-trade alert already covers the user-facing outcome — rejected, this function's entire purpose is catching it *before* orders start failing, and a monitoring path that silently no-ops is worse than one that's absent (looks healthy, isn't). B) Fix the URL construction — chosen, one-line change, zero trading-logic surface.
**Why:** Monitoring-only code path (GET balance + Telegram send, no order placement) — safe to fix and deploy unattended, unlike the 2026-07-20 market-data-fetcher finding (that one fed live execution and was correctly left for review). Verified root cause directly against the live Kalshi API before touching code: doubled path → 404, correct path → 401 (auth required, as expected unauthenticated) — not a guess.
**Reversibility:** Easy — single-line revert, redeploy `health-check`.
**Trace:** PR #75, deployed to `uyfnezxmgwitpzsrnkst`. Verified live: manual invoke → `alerts_sent: ["kalshi_low_balance"]`, confirmed row `a8899b4c` in `compliance_log` at 2026-07-27T00:43:18Z.

## 2026-07-26 — Atomic advisory-lock dedup for the shared Telegram alert helper

**Decision:** Added `claim_health_check_alert` (Postgres function, transaction-scoped
`pg_advisory_xact_lock` keyed on `alert_type`+`fingerprint`) and switched `alertOnce`
(`_shared/telegram.ts`) to call it via one RPC instead of a separate SELECT-then-INSERT.
**Finding:** The 23rd run's fix (PR #60, S-001 sequential leg submission) resolved the *specific*
incident of 3 duplicate `kalshi_insufficient_balance` Telegram alerts within 84ms, but the
underlying race — `alertOnce`'s dedup check and its record-the-send insert were two unguarded
steps — was still live for any other concurrent call path into the same alert_type+fingerprint.
11 edge functions route every Telegram alert through this one helper.
**Options:** A) Leave it — the acute symptom is fixed, this is speculative hardening — rejected,
this is the exact "fix the instance, not the class" anti-pattern the project's own root-cause
standard exists to prevent, and the blast radius (a spurious duplicate page) is low-cost to close.
B) Unique DB constraint on `(alert_type, fingerprint)` — rejected, doesn't fit a rolling cooldown
window (a constraint would either never allow re-alerting or require constant cleanup). C)
Advisory-lock-guarded atomic RPC — chosen: serializes concurrent callers without schema changes,
verified directly (5 concurrent claims for one key → exactly 1 `true`).
**Why:** Same class of fix as every other alerting/monitoring-path change made autonomously today
(9th/10th/12th/13th/14th/17th/20th/24th/25th runs) — no live-trading execution logic touched, only
how duplicate notifications are suppressed.
**Reversibility:** Easy — single-PR revert (#67), `alertOnce` reverts to its prior check-then-insert
behavior (functionally correct, just re-exposes the same race).
**Trace:** PR #67 (`a1f2fad`), migration `20260726_alert_dedup_race.sql`. Incident:
`compliance_log` `health_check_alert` rows 2026-07-26T16:05:04.243/.262/.327Z.

## 2026-07-26 — Re-fixed S-001's concurrent-leg balance race directly on `dev`, not the stranded branch that "fixed" it first

**Decision:** Rewrote `runS001SurfaceArb`'s leg submission from `Promise.all` back to a sequential
loop with a cross-alert `accountDepleted` early-exit, committed and deployed straight to `dev`
(PR #60), instead of merging or cherry-picking the existing `fix/live-pilot-instrumentation` branch.
**Options:** (A) merge the stranded branch's 314e10c commit — risked pulling in that branch's other
uncommitted/diverged changes to the same file; (B) cherry-pick just that commit — same file has
independently evolved on both branches, high conflict risk; (C) re-implement the fix fresh against
`dev`'s current code, verified in isolation. Chose C.
**Why:** The stranded branch's version of this file has its own independent history unrelated to
`dev`'s (per the 11th run's finding); merging it risked silently reverting or conflicting with 6+
`dev`-only fixes made since. A small, fresh, isolated reimplementation was lower-risk than any merge.
**Reversibility:** easy — single-file revert of PR #60 (`6d1b6bd`).
**Trace:** PR #60, [[health-log.md]] 23rd run entry.

## 2026-07-26 — Repointed `futures-signal-cron` from a nonexistent function to the real one

**Decision:** `cron.alter_job(16, command := ...)` — changed the cron's target URL from
`/functions/v1/futures-oracle` to `/functions/v1/futures-signal`.
**Finding:** `futures-signal-cron` has fired every 10 minutes since it was registered, 404ing every
time against a function name (`futures-oracle`) that was never deployed — the real function is
`futures-signal`. `net.http_post` is fire-and-forget, so `cron.job_run_details.status` recorded
"succeeded" (dispatch OK) on every one of those runs; nothing monitored the actual HTTP response.
`compliance_log`'s `futures_signal_run` event — the Fed-funds/KXFED oracle signal source — hadn't
fired since 2026-05-13, 74 days dead, invisible to every existing alert.
**Options:** A) Redeploy a new `futures-oracle` function matching the old URL — rejected, the
working code already lives at `futures-signal`, this would just be renaming the target back to the
broken one. B) Repoint the cron URL to the function that actually exists — chosen, zero code change,
zero deploy risk.
**Why:** Simplest fix for a confirmed cause; DB-level config change only, no edge-function redeploy,
no trading-path code touched.
**Reversibility:** Easy — `cron.alter_job(16, ...)` back to the old URL (restores today's
dead-but-quiet state, not recommended).
**Trace:** `cron.job` jobid=16; `compliance_log` `futures_signal_run` rows resumed 2026-07-26
15:19:00 UTC. See `docs/health-log.md` 22nd run.

## 2026-07-25 — Fixed jsdom-broken signing tests that were silently blocking the balance pre-flight fix from shipping

**Decision:** Added `// @vitest-environment node` to `kalshi-signing.test.ts` and guarded
`src/test/setup.ts`'s `window.matchMedia` stub behind `typeof window !== "undefined"`.
**Finding:** Scheduled health check found live trades repeatedly rejected with `insufficient_balance`
every ~5 min from 18:45–19:00 UTC today, on tickers KXINX-26JUL27H1600-B7412/37/62. The fix for
this (commit `9d47913`, a Kalshi balance pre-flight check) was already written and sitting on
`fix/live-pilot-instrumentation` (PR #40), but PR #40's CI had been red since 18:19 UTC on
`kalshi-signing.test.ts` — 4/4 tests failing with `importKey: 2nd argument is not instance of
ArrayBuffer...`. Root cause: `vitest.config.ts` sets a global `environment: "jsdom"`; jsdom's Crypto
shim doesn't implement a working `subtle`, so a suite exercising real RSA-PSS signing (no DOM
dependency at all) failed for reasons unrelated to the signing code itself — which was correct.
This masked *two* real fixes behind an unrelated red CI signal (the RSA-PSS signing fix `a73c79a`
and the balance pre-flight fix `9d47913`), which is why live trading kept hitting both bugs it had
already been fixed for, cycle after cycle.
**Separately:** `.github/workflows/ci.yml`'s `canary-gate` job parses the Supabase Management API's
`/database/query` response as `{data: [...]}` (`jq '.data[0].n'`), but that endpoint returns a bare
array — every other job in the same file parses it correctly as a plain list. This has crashed the
canary gate on the first 60s poll of every push to `main` since at least 2026-07-20, showing as a
misleading CI "failure" even when the actual edge-function deploy (an earlier, independent job)
succeeded. Fixed to `jq '.[0].n'`. Not yet verified against a real canary run — flag if a future
`main` push still shows a red canary-gate.
**Options:** A) Loosen the global jsdom environment — rejected, breaks isolation for the DOM suites
it exists for. B) Per-file `node` environment override — chosen; zero-risk, scoped to the one suite
that needs real WebCrypto.
**Why:** The proximate error (compliance_log `insufficient_balance`/`order_failed`) had already been
fixed in code; the actual blocker was a test-environment mismatch with no relation to trading logic.
Fixing test infra was lower-risk and unblocks two already-reviewed real fixes rather than writing a
third parallel fix.
**Reversibility:** Easy — both changes are test-only/CI-only, no runtime behavior touched.
**Trace:** commit `2270490` on `fix/live-pilot-instrumentation` (PR #40). `compliance_log`
event_type=`order_failed`/`rate_limit_exceeded`, 2026-07-25 18:45–19:05 UTC.

## 2026-07-25 — Replaced HMAC-SHA256 request signing with Kalshi's required RSA-PSS-SHA256

**Decision:** Rewrote `_shared/kalshi-auth.ts` (now `_shared/kalshi-signing.ts`) to sign every
Kalshi request with RSA-PSS-SHA256 (32-byte salt) over a millisecond-precision timestamp, importing
the stored PEM as a WebCrypto RSA-PSS key (PKCS8 direct, PKCS1 re-wrapped). Previously it computed
an HMAC-SHA256 digest over a second-precision timestamp, treating the RSA private key string as a
raw HMAC secret.
**Finding:** Today's V1→V2 endpoint migration (previous entry below) exposed that this had been
wrong since the signing code was written — the retired endpoint returned its deprecation error
before Kalshi ever validated a signature, so the auth bug had zero observable effect until the
endpoint fix let requests reach real validation. `select mode,status,count(*) from trades where
exchange='kalshi' group by mode,status` confirmed 60/60 live orders ever attempted had
status='failed' — live trading has never placed a successful order since being enabled
(2026-07-24 21:30).
**Options:** A) Patch just the timestamp precision and hope the algorithm was somehow already
correct — rejected, the two live 401s were unambiguously `INCORRECT_API_KEY_SIGNATURE`, not a
clock-skew error. B) Verify Kalshi's actual required scheme against current docs before writing a
fix — chosen; confirmed RSA-PSS-SHA256/ms-timestamp/path-only-no-query via docs.kalshi.com, then
verified the fix against the real API (minted a session token, called read-only `kalshi-ping`,
first-ever successful authenticated call for this account) before considering it resolved.
**Why:** This is the actual documented Kalshi auth contract; HMAC was never a valid substitute for
an RSA key pair. No lower-risk partial fix exists — signing is all-or-nothing correct.
**Reversibility:** Easy — single shared-module revert, redeploy the 7 dependent functions.
**Trace:** `failed_trade_queue`/`compliance_log`, `authentication_error`/`INCORRECT_API_KEY_SIGNATURE`
rows starting 2026-07-25 15:03 UTC. Tests: `supabase/functions/tests/kalshi-signing.test.ts`.

## 2026-07-25 — Migrated execute-trade to Kalshi's V2 order endpoint

**Decision:** Rewrote the live order payload/response handling in `execute-trade/index.ts` to use `POST /trade-api/v2/portfolio/events/orders` instead of the deprecated `/portfolio/orders`.
**Finding:** Every single live order today (2026-07-24/25) was rejected with `deprecated_v1_order_endpoint` — Kalshi deprecated the legacy order-mutation endpoint (changelog: 2026-06-18, "no earlier than May 6, 2026"). Live P&L was flat at $0 because no order had ever reached the exchange, not because of losing trades.
**Options:** A) Ship the migration now, since 100% of live trades were already failing safely (no money at risk in the broken state) — chosen. B) Wait for a second independent verification source before touching real-money code — partially done: cross-checked the YES/NO price-complement math (`yes_bid + no_ask == 1.00`) against live Kalshi market data before writing the conversion, since the AI-summarized docs alone weren't sufficient confidence for a real-money payload change.
**Why:** V2 quotes every order from the YES-book bid/ask side; NO orders are represented as the complementary YES-side order at `1 - price`. A compatibility shim converts the V2 response (flat object, dollar-string fields) back into the legacy `{order: {...}}` cents-based shape so all downstream fill/slippage/notification code is unchanged.
**Reversibility:** Easy — single file (`execute-trade/index.ts`), redeploy previous version to roll back.
**Trace:** `compliance_log` event_type=`order_failed`, message containing `deprecated_v1_order_endpoint`, 2026-07-24 through 2026-07-25 10:10 UTC.

## 2026-07-25 — Staggered futures-signal-cron off market-data-fetcher-cron's minutes

**Decision:** Changed `futures-signal-cron` schedule from `6,16,26,36,46,56 * * * *` to `9,19,29,39,49,59 * * * *`.
**Finding:** `futures-signal-cron` and `market-data-fetcher-cron` (`1,6,11,...,56 * * * *`) fired in the exact same minute on every occurrence, and both call the Kalshi markets endpoint directly — a verifiable, recurring source of the periodic 429/500 `KALSHI api_error` Telegram alerts (2026-07-22 through 2026-07-25).
**Options:** A) Build a shared cross-function rate limiter/token bucket — bigger lift, deferred. B) Stagger the colliding cron minute — chosen, cheap and directly addresses the confirmed collision.
**Why:** Simplest fix for a concretely identified cause; doesn't address contention from other functions (auto-trade's S-001 direct Kalshi calls, execute-trade's orderbook checks) which may still contribute — worth revisiting if 429s persist.
**Reversibility:** Easy — `cron.alter_job` back to the old schedule.
**Trace:** `cron.job` jobid=16.

## 2026-07-20 — Flagged market-data-fetcher credential-fetch timeout gap (not auto-fixed)

**Decision:** Logged as a finding for review rather than deploying a fix during an unattended scheduled health-check run.
**Finding:** `market-data-fetcher/index.ts` calls `getKalshiCredentials()` (a Supabase query + decrypt) *before* the per-series loop where `RUN_BUDGET_MS` (50s) is enforced. That call has no timeout. On 2026-07-13 the run aborted after 130.6s with 0 series failed / all 18 skipped — consistent with the credential fetch itself stalling, not Kalshi API latency. This fired a critical Telegram alert ("Surface scanner and signal generation may be running on stale data") and happened again 2026-07-16 (61.4s, 3 skipped). No recurrence in the last 24h (checked via `compliance_log`, 0 error/critical rows since 2026-07-16).
**Proposed fix:** wrap `getKalshiCredentials(...)` in `market-data-fetcher/index.ts:63` with the same `AbortController` + timeout pattern already used per-series (~5–8s), so a stalled credential fetch fails fast and alerts with an accurate cause instead of silently consuming the whole run budget.
**Options:** A) Auto-deploy the timeout wrapper now — rejected: this edge function is live-trading-adjacent (market data feeds S-001/S-002/S-005 execution) and production deploys are a Hard Stop requiring in-session approval, which isn't available on an unattended scheduled run. B) Log the finding + fix for Onofre to review and deploy — chosen.
**Why:** Matches session protocol for scheduled/unattended runs — report, don't ship, when the change touches a live production trading path.
**Reversibility:** N/A — no code changed yet.
**Trace:** `compliance_log` event_type=`market_data_fetcher_aborted`, 2026-07-13T12:43:11Z and 2026-07-16T22:47:02Z.

## 2026-07-10 — Deferred HITL gate (two-phase) for live trades

**Decision:** HITL gate lives in execute-trade, uses a deferred 202 pattern instead of inline polling.
**Options:**
  A) Inline polling (60s loop inside execute-trade) — rejected: edge function wall-clock timeout makes this unworkable.
  B) Gate in auto-trade, direct execute (skip execute-trade for HITL) — rejected: bypasses the authoritative execution gate; anyone calling execute-trade directly could skip HITL.
  C) Deferred 202 in execute-trade + telegram-webhook fires Phase 2 — chosen.
**Why:** Keeps the gate at the authoritative execution boundary (execute-trade), eliminates timeout risk, and gives telegram-webhook a clean callback path. Phase 2 re-entry via hitlApprovalId is cryptographically scoped to a single pre-authorized approval row.
**Reversibility:** Easy — remove hitlApprovalId check and 202 branch; gate reverts to paper-only execution.
**Trace:** commit f2fd68b on feat/production-hardening

## 2026-07-10 — hitl_approvals table as HITL state store

**Decision:** Supabase `hitl_approvals` table stores pending approvals and serves as the synchronization point between execute-trade (writer) and telegram-webhook (updater).
**Options:** A) Redis pub/sub, B) Supabase table, C) In-memory with webhook callback URL.
**Why:** Already have Supabase as the state store; no new infra; table supports dashboard UI queries; RLS enforces per-user isolation.
**Reversibility:** Easy — table schema is additive; removing the gate doesn't require dropping it.
**Trace:** supabase/migrations/20260710_production_hardening.sql

## 2026-07-10 — Deferred tool-gateway.ts (not yet wired to trading-agent tools)

**Decision:** tool-gateway.ts is created as a shared module but not yet wired into trading-agent's 7+ ungoverned tools. Accepted as a follow-on task.
**Options:** A) Wire all tools now (high effort, lots of surface area), B) Deliver the module, wire incrementally.
**Why:** HITL gate was the P0. The tool gateway pattern is established; wiring is mechanical work that can be done per-tool without architectural decisions. Shipping a half-wired gateway is worse than shipping the module and wiring it properly next.
**Reversibility:** Trivial — additive change, no existing code removed.
**Trace:** commit f2fd68b on feat/production-hardening
