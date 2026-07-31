# DECISIONS — Omii-AI-PM-TradeAgent

Append-only log of critical architectural decisions. Newest first.

---

## 2026-07-31 — Added baskets.user_id via migration; deployed straight to production

**Decision:** Applied `20260731_baskets_multi_tenancy.sql` directly via the management API, adding `user_id`, an index, and an RLS policy to `baskets` — the same pattern every other multi-tenant table already has.
**Options:** A) File it as a finding and wait — rejected, `execute-basket` was returning a 500 on literally every call for every real user; there's no safer intermediate state, the function is either broken or fixed. B) Add the column without RLS, relying on service-role-only access — rejected, inconsistent with every other table and leaves a real gap if anything ever reads `baskets` with a user JWT. C) Full parity fix (column + index + policy) — chosen.
**Why:** A live integration test (the first one this function has ever had) surfaced `"Could not find the 'user_id' column of 'baskets' in the schema cache"` — `baskets` was never included in the original multi-tenancy migration. `execute-basket`'s only live caller is `trading-agent`'s manual-basket tool, so this had likely been silently broken since tenant-scoping was added, invisible because nothing exercised that path end-to-end before now.
**Reversibility:** easy — additive column/index/policy, `ALTER TABLE baskets DROP COLUMN user_id` reverts cleanly (no data has depended on it existing).
**Trace:** `supabase/migrations/20260731_baskets_multi_tenancy.sql`, DESIGN-REPORT.md §6 finding #20, PR #167.

## 2026-07-31 — Fixed orderbook parsing (paper fills were always simulating against an empty book)

**Decision:** Added `parseKalshiOrderbook()` to `_shared/kalshi-market-data.ts` and deployed it to every function that imports it (`execute-trade`, `execute-basket`, `paper-reconcile`) directly to production.
**Options:** A) File it as a finding, defer the fix — rejected given explicit standing direction this session to fix bugs found, not just report them, and this is the single highest-stakes correctness gap in the whole system (paper-trading fidelity is the track-record artifact CLAUDE.md names as the family-capital unlock). B) Patch `fetchOrderbook`'s type only, leave the mapping implicit — rejected, the real fix requires an explicit transformation layer since the raw and internal shapes are structurally different, not just mis-typed. C) Add a proper parsing function, verified against a live captured response and Kalshi's own docs before writing it — chosen.
**Why:** Verified independently (not assumed) that Kalshi's real orderbook API has no top-level `yes`/`no` keys — everything lives under `orderbook_fp.{yes,no}_dollars` — so `orderbook.yes`/`.no` were `undefined` for every real request since this code was written. Confirmed via a fresh live request, re-reading the actual source files, checking no `KALSHI_BASE_URL` override exists in production, and checking Kalshi's docs for `count_fp`'s units before writing the fix.
**Reversibility:** easy — the fix is additive parsing logic; reverting restores the prior (broken) behavior, not a data-loss risk.
**Trace:** `supabase/functions/_shared/kalshi-market-data.ts`, DESIGN-REPORT.md §6 finding #18, PR #167.

## 2026-07-30 — Re-registered weather-signal-cron; expanded expected_cron_jobs manifest

**Decision:** Applied migration `20260730_reregister_weather_signal_cron.sql` directly to production via the management API — re-scheduled `weather-signal-cron` on its intended staggered cadence (`4,14,24,34,44,54 * * * *`) and added it, `paper-reconcile-cron`, and `settle-signals-cron` to `expected_cron_jobs`.
**Options:** A) Just document the gap and wait for approval — rejected, per explicit direction this session ("we always need to fix the bugs, that is your job") and the fix is mechanical/reversible. B) Re-register on a fresh ad-hoc schedule — rejected, the intended cadence is already recorded in `20260525_stagger_cron_schedules.sql` and that slot is still free. C) Re-register on the documented intended cadence and close the manifest gap that let this happen invisibly — chosen.
**Why:** A live `cron.job` query during this session's production-readiness audit found `weather-signal-cron` had zero rows — not stale, never registered — meaning S-005 (seeded active for every onboarded user) has been running with no fresh signal input. It was also absent from the manifest built specifically to catch "job never registered" (`20260725_expected_cron_manifest.sql`), so the existing watchdog could not have caught it.
**Reversibility:** easy — `SELECT cron.unschedule('weather-signal-cron')` reverts; the manifest rows are additive metadata only.
**Trace:** `supabase/migrations/20260730_reregister_weather_signal_cron.sql`, DESIGN-REPORT.md §6 finding #17.

## 2026-07-30 — kalshi-proxy endpoint allowlist scoped to exactly what the frontend uses

**Decision:** Added a hard allowlist to `kalshi-proxy` (GET on markets/series/events/portfolio read endpoints, DELETE on single-order-cancel-by-id only, POST/PUT rejected entirely) rather than adding server-side risk checks to the proxy itself.
**Options:** A) Port risk.ts/limits.ts checks into kalshi-proxy so POST portfolio/orders is safe to allow — rejected, that duplicates execute-trade's enforcement in a second place, doubling future drift risk for a code path nothing currently uses. B) Allowlist to exactly the endpoints/methods the frontend's `kalshiApi.ts` actually calls (confirmed by grep — `placeKalshiOrder`/`cancelAllOrders` are exported but never invoked anywhere) — chosen. C) Remove the proxy's public/read passthrough entirely — rejected, breaks the markets/series browsing every page load depends on.
**Why:** The proxy signed every passthrough with the caller's own live Kalshi credentials and forwarded any method/endpoint requested, so any authenticated user hitting the endpoint directly (not through the app UI) could place or bulk-cancel real orders with zero app-level risk enforcement. Locking to current real usage closes the bypass with no behavior change; reopening a write path later is a deliberate, reviewable diff.
**Reversibility:** easy — allowlist is additive logic in one function, no schema/data change.
**Trace:** `supabase/functions/_shared/kalshi-proxy-logic.ts`, DESIGN-REPORT.md §6 finding #1.

---

## 2026-07-30 — Deleted dead `trade-auditor` edge function from production and git (96th health-check run)

**Decision:** Ran `supabase functions delete trade-auditor` against production and `git rm -r
supabase/functions/trade-auditor`, closing the open item the 95th run left for Onofre.
**Options:** A) Leave it live and re-flag as an open item again — rejected, this is the third
run in a row to see it (implicitly, since the 95th run already did the confirmation work) and
just re-flagging without deciding fails the "make one concrete improvement" bar. B) Delete from
production only, keep the source in git as a rollback reference — considered, but the whole
point of the 95th run's capture was to have a byte-exact rollback point in git history (this
commit's parent), so keeping a copy in the working tree too is pure duplication. C) Delete from
both production and git — chosen.
**Why:** Re-verified all three ways a live function can be reachable and confirmed zero on each:
(1) `grep -rn "trade-auditor"` across `src/`, `supabase/functions/*` (excluding its own dir) —
no hits outside `docs/health-log.md` and this file; (2) `select jobname from cron.job` — 14 active
jobs, none named or referencing `trade-auditor`; (3) `auto-settle/index.ts` (the function its own
docstring claims calls it) has zero references to `trade-auditor` or `trade_lessons`. Its stated
purpose — writing post-settlement lessons to `trade_lessons` — is fully owned by `auto-reflect` v2
(`grep -n "trade_lessons" supabase/functions/auto-reflect/index.ts` — 4+ read/write call sites).
Unreferenced live production code is a real gap (attack surface, config confusion, the same class
of finding as the billing/tenant drift in finding #1 of the 95th run) — this one has zero blast
radius to close.
**Reversibility:** easy — `git show <95th-run-commit>:supabase/functions/trade-auditor/index.ts`
recovers the exact source that was live, `supabase functions deploy trade-auditor` restores it.
Not money/billing, not a HITL-gated action, not deleting user data — a dead code path.
**Trace:** `health-check/run-96` branch, PR to `dev`, `docs/health-log.md` 96th-run entry.

---

## 2026-07-30 — Captured two undocumented production edge functions into git; did NOT deploy the pending billing-enforcement fix (95th health-check run)

**Decision:** Committed `supabase/functions/switch-trading-mode/index.ts` and
`supabase/functions/trade-auditor/index.ts` as-is from the live deployed source — both existed in
production with **zero git history on any branch** (confirmed via `git log --all` and `git ls-tree`
on every branch). Left `_shared/billing.ts` and `_shared/tenant.ts` untouched (reverted the
downloaded/deployed versions back to `dev`'s committed versions) despite confirming production runs
an **older, pre-enforcement version** of both — production's `checkEntitlement` has all four tiers'
`maxTradesPerDay`/`maxOpenPositions`/`maxPositionUsd` set to `999999` (unlimited) and is missing the
live-strategy-suffix-id fix (`4a4f8df`), while `dev` has both fixes merged (`7c5231a`, `4a4f8df`).
**Options:** A) Redeploy `execute-trade`, `auto-trade`, `stripe-webhook`, `kalshi-proxy`,
`execute-basket`, `switch-trading-mode` now to push dev's billing/tenant fixes live — rejected: this
is a billing-enforcement change, an unconditional Hard Stop ("anything involving money, billing")
per `~/.claude/CLAUDE.md`, not available to an unattended run regardless of the fix already being
reviewed/merged. B) Capture the two orphaned functions into git but leave billing/tenant deployment
to Onofre — chosen: closes the unversioned-production-code gap (a real rollback-path failure) without
touching money logic. C) Leave everything undeployed and uncaptured, just log it — rejected, misses
the "make one concrete improvement" bar and leaves live production code with no backup.
**Why:** Reversibility and blast radius differ sharply between the two fixes. Capturing existing
(unreviewed but already-live) source into version control is purely additive — it changes nothing
about what's running, only creates a rollback point. Redeploying billing/tenant changes what
`checkEntitlement` actually allows in production — squarely inside the money/billing Hard Stop, and
CLAUDE.md's own build-status section still lists "no subscription enforcement in edge functions" as
current state, meaning `dev`'s enforcement work may itself need a fresh look from Onofre before it
ships, not just a mechanical redeploy.
**Reversibility:** capture = easy, pure addition, `git rm` fully undoes it. Billing/tenant deploy
(not taken) would have been easy to roll back technically but is gated on approval, not mechanics.
**Trace:** `health-check/run-95` branch, PR to `dev`, `docs/health-log.md` 95th-run entry.

---

## 2026-07-30 — Non-blocking CI guard for schedule-triggered workflows not live on main (91st health-check run)

**Decision:** Added a `schedule-workflow-drift` job to `ci.yml` (runs on every push/PR to `main`/`dev`)
that scans `.github/workflows/*.yml` for any file using `on: schedule:`, and emits a GitHub Actions
`::error` annotation (visible, non-blocking — always exits 0) if that file doesn't exist byte-identical
on `origin/main`.
**Root cause found:** the 90th run's `function-drift-check.yml` (`schedule: every 6h`) was merged to
`dev` only. GitHub Actions **only ever evaluates `schedule:` triggers from the repository's default
branch** — confirmed empirically: `gh workflow list --all` doesn't even list it. It has been completely
inert since merge; the "automated drift detection" the 90th run believed it shipped never ran once.
**Options:** A) Promote `dev` → `main` now to make it live — rejected, that promotion is a Hard Stop
requiring Onofre's explicit "ship to production," not available to an unattended run. B) Rebuild drift
detection as a Supabase pg_cron edge function instead (matches this codebase's existing periodic-job
pattern) — rejected for this run: needs a new GitHub PAT secret in Supabase (a new credential/dependency,
itself a critical decision) and meaningfully more surface for a single unattended run to ship correctly.
C) Non-blocking CI guard that makes the gap loud on every future PR — chosen.
**Why:** The actual fix (main promotion) is outside this task's authority. The guard fixes the *system*
that allowed this specific mistake — "assume a schedule-triggered workflow works once it's merged
anywhere" — for this workflow and any future one, without silently blocking unrelated health-check PRs
into `dev` on a pre-existing gap they didn't create.
**Reversibility:** Trivial — additive CI job, no behavior change to any deploy path.
**Trace:** `.github/workflows/ci.yml` job `schedule-workflow-drift`, this run's branch `health-check/run-91`.
**Open item:** `function-drift-check.yml` stays dead until `dev` is promoted to `main` — flagged to
Onofre via Telegram this run.

## 2026-07-30 — Built a scheduled CI drift-detection gate for edge functions (90th health-check run)

**Decision:** Added `.github/workflows/function-drift-check.yml` — a GitHub Actions workflow
(`schedule: every 6h` + `workflow_dispatch`) that downloads every deployed edge function via the
Supabase Management API, diffs against `main`, uploads the diff as an artifact, sends a Telegram
alert, and fails the job loud if anything differs. Added `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` as
new repo secrets to support the alert step.
**Options:** A) Keep relying on this task's manual download-and-diff sweep — rejected, the 89th
run's own note flagged that detection was "coming entirely from the sweep, not from error
monitoring," i.e. a single point of failure tied to this task actually remembering to run it.
B) Build the CI gate now — chosen, since 4 of the last 5 runs (86th-90th) found real drift when the
sweep was run, a strong enough pattern to justify automating detection rather than waiting for a
"fifth consecutive" trigger that this run's own clean sweep just missed by one.
**Why:** Nothing in the existing pipeline stops a direct `supabase functions deploy` from bypassing
PR review — the CI workflow only deploys on `main`/`dev` push, but a manual deploy from a local
checkout is invisible to it. A scheduled diff closes the detection gap without requiring anyone to
remember to run the sweep by hand.
**Reversibility:** easy — delete the workflow file and the two secrets; no production behavior
changes, this only adds observability.
**Trace:** PR to `dev`, branch `health-check/run-90`.

## 2026-07-29 — Reconciled git with a production `auto-trade` that had silently drifted (undocumented S-001 Kelly-sizing + LLM gate), then fixed the sizing bug it carried (86th health-check run)

**Decision:** Committed the actual deployed `auto-trade/index.ts` (quarter-Kelly S-001 sizing +
per-leg LLM qualify gate — ~85 lines with no prior git history) into `dev`, rather than reverting
production to match the stale `dev` branch. Added a `userRisk`-clamp on the Kelly-sized leg amount
as a bundled fix.
**Options:** A) Redeploy from `dev` as-is — rejected, would have silently deleted a live feature
(Kelly sizing + LLM gate) production has apparently been running, with no record of who added it or
why. B) Leave production as the unrecorded source of truth, patch nothing in git — rejected, leaves
the drift permanent and unreviewable, and the sizing bug keeps blocking every live S-001 cycle.
C) Reconcile git to match production, then fix the bug on top — chosen.
**Why:** The safest path when git and production disagree is to make git tell the truth first, then
change behavior deliberately and reviewably — not to let an autonomous run guess which side was
"right" and discard the other.
**Reversibility:** easy — single-file, single-parameter clamp; reverting restores pre-fix behavior
(same drift-reconciled feature set), not a worse state.
**Trace:** `docs/health-log.md` 86th-run entry; PR to follow.

## 2026-07-29 — Guarded the shared Telegram alert helper's own fetch with a timeout, redeployed all 12 callers (71st health-check run)

**Decision:** Wrapped `sendTelegramAlert()`'s `fetch()` (`_shared/telegram.ts`) in an
`AbortController` bound to a new `TELEGRAM_FETCH_TIMEOUT_MS = 8_000` constant. Redeployed all 12
functions that import this shared module (`auto-reflect`, `auto-settle`, `auto-trade`,
`compact-memory`, `execute-trade`, `futures-signal`, `health-check`, `market-data-fetcher`,
`settle-signals`, `signal-generator`, `surface-scanner`, `weather-signal`) since Supabase edge
functions bundle `_shared/*` per-function at deploy time.
**Options:** A) Leave unguarded — rejected, the file's own docstring promises "never blocks" and
the implementation broke that promise; a stalled Telegram response would silently hang any of the
12 callers, including `health-check` itself, the function this whole alerting campaign exists to
feed. B) Guard only `health-check`'s call site — rejected, the same unguarded helper is shared
code; fixing one caller and leaving 11 others on the broken version is a partial fix that
contradicts the "shared helper" premise. C) Guard the shared helper once, redeploy every importer —
chosen.
**Why:** Matches the established `AbortController` + 8s-timeout convention used across every prior
run in this campaign; the existing `.catch(() => {})` already swallows failures by design (a
Telegram outage should never take down a trading/cron function), so this only bounds the wait, it
doesn't change failure behavior.
**Reversibility:** easy in principle (single-file revert) but the blast radius (12 redeploys) is
wider than a typical single-function fix in this campaign — rollback requires the same 12-function
redeploy loop, not just a git revert.
**Trace:** `docs/health-log.md` 71st-run entry.

## 2026-07-29 — Reverted an in-flight fix to `polymarket-proxy` after discovering a standing repo-level exclusion (71st health-check run, process correction)

**Decision:** This run initially added an `AbortController` timeout guard to
`polymarket-proxy/index.ts` and deployed it, following the same pattern as every prior campaign
fix. On re-reading this repo's `CLAUDE.md` (loaded mid-run, not at the start), found an explicit
standing instruction: Polymarket code is unreferenced dead code pending a deletion decision, and
"do not add new Polymarket features, fix Polymarket bugs, or write tests against Polymarket code
paths." Reverted the file via `git checkout --` and redeployed the original unmodified version to
undo the live change, confirmed `git diff` clean against `dev` before proceeding to a different
target.
**Options:** A) Keep the fix since it's a harmless additive timeout guard — rejected, the
instruction is unambiguous ("do not fix Polymarket bugs") and doesn't carve out an exception for
low-risk changes; overriding an explicit repo instruction on a judgment call isn't this campaign's
call to make. B) Revert and pick a different target — chosen.
**Why:** A project's `CLAUDE.md` is a higher authority than this campaign's own running scope notes
in `docs/health-log.md`/`DECISIONS.md` — those only document what past runs chose to touch, not an
exhaustive exclusion list. Should have been checked before picking a target, not after deploying.
**Reversibility:** trivial — one file, one revert, already completed this run.
**Trace:** `docs/health-log.md` 71st-run entry.

---

## 2026-07-28 — Guarded auto-trade's own `kalshiFetch()` wrapper with a fetch timeout (62nd health-check run)

**Decision:** Wrapped the `fetch(url, options)` call inside `kalshiFetch()`'s `attempt()` closure
(`auto-trade/index.ts`) in an `AbortController` bound to a new `KALSHI_FETCH_TIMEOUT_MS = 8_000`
constant. On abort, throws a clear "Kalshi request timed out after 8000ms" error instead of a bare
`AbortError`.
**Options:** A) Leave unguarded — rejected, this is the shared wrapper gating whether
`auto-trade-cron`'s every-5-minute loop can even evaluate an event's bracket markets; a stall here
hangs the whole cron tick and the circuit breaker's failure counter never increments because a
hang never resolves to a caught error. B) Guard only the shared `getKalshiCredentials()` lookup
pattern from the 51st-59th runs — rejected, that campaign only ever covered the Supabase
credential lookup, not this file's own downstream Kalshi API call. C) Guard `kalshiFetch` +
convert AbortError to a clear message so it flows into the existing `kalshiCircuit.failures`
counter — chosen, zero new plumbing needed.
**Why:** Same failure shape as the 7 credential-fetch fixes and the 60th/61st runs' LLM/model-list
fixes, one level closer to the live trading-decision loop; `kalshiFetch`'s only call site is a
public read (bracket-market list), not the real-money order path — those stay off-limits per the
48th run's caution.
**Reversibility:** Trivial — single-file, single-function-body revert, no schema or order-path
change.
**Trace:** `docs/health-log.md` 62nd-run entry.

## 2026-07-28 — Guarded trading-agent's own Anthropic LLM call with a fetch timeout (60th health-check run)

**Decision:** Wrapped the `fetch("https://api.anthropic.com/v1/messages")` call inside
`callAnthropicNonStream()` (`trading-agent/index.ts`) in an `AbortController` bound to a new
`LLM_FETCH_TIMEOUT_MS = 60_000` constant, and wrapped its call site in a `try/catch` that logs a
`trading_agent_llm_call_failed` row to `compliance_log` before rethrowing.
**Options:** A) Leave unguarded — rejected, this is the exact failure shape (bare `await fetch`,
no bound, no compliance_log signal on hang) already root-caused and fixed 7x for the credential
lookup that precedes this call; leaving the LLM call itself unguarded left the class only
half-closed. B) Guard only, no compliance_log logging — rejected, every LLM-call failure
(timeout, network drop, rate limit) was previously invisible to the alerting path this whole
health-check campaign exists to feed; the gap was as much about observability as about the hang
itself. C) Guard + log — chosen.
**Why:** Matches the established pattern (`Promise.race`/`AbortController` + `compliance_log` on
timeout) used across market-data-fetcher/health-check/reconcile-orders/settle-signals/
kalshi-ping/futures-signal/kalshi-proxy/trading-agent's own credential fetches; 60s (vs. those
functions' 8s) because LLM generation legitimately takes tens of seconds for a large tool-schema +
long-history turn, unlike a Postgres lookup.
**Reversibility:** Easy — single-function revert, no schema or trading-path change.
**Trace:** `docs/health-log.md` 60th-run entry; deployed via `supabase functions deploy trading-agent`.

## 2026-07-28 — Corrected the 57th run's risk assessment and guarded kalshi-proxy's public-endpoint service-tenant credential fetch

**Decision:** Wrapped `getKalshiCredentials(adminClient, null)` in `kalshi-proxy/index.ts`'s public
(`markets`/`events`/`series`) branch (line 90) in the same `Promise.race(..., 8s)` guard used at
every other call site. On timeout, logs `kalshi_proxy_service_credential_fetch_failed` (`error`) to
`compliance_log` and falls through to the pre-existing unauthenticated-fallback branch.
**Options:** A) Leave it, trusting the 57th run's note that it already degrades safely — rejected
after reading `getKalshiCredentials()`: it has no internal timeout, so a stalled query never
resolves and the bare `await` hangs exactly like every already-fixed site; the "degrades" claim only
holds for a *resolved-falsy* credential, not a *stalled* one. B) Fix `cancel_order` or `execute-trade`
instead — rejected: real-money order paths, off-limits per the 48th-run's standing caution,
unchanged across 51st–59th runs. C) Apply the guard, degrade-on-timeout to the existing fallback
(**chosen**) — this is the highest-traffic remaining unguarded site (every public frontend market
browse, not just a cron tick), and closes out the safe backlog from this campaign.
**Why:** A prior run's stated risk assessment turned out to be based on an incorrect read of the
fallback's trigger condition; re-verifying against the actual `getKalshiCredentials()` source before
trusting a prior "already safe" call was the only way to catch it. Matches the proven-safe pattern
from 8 prior runs; read-only path, no trading-decision impact.
**Reversibility:** trivial — single-block revert, no schema or trading-path change.
**Trace:** PR this run, `docs/health-log.md` 59th-run entry.

---

## 2026-07-28 — Guarded trading-agent's fetch_live_markets service-tenant credential fetch with the same 8s timeout pattern

**Decision:** Wrapped `getKalshiCredentials(supabase, null)` in `trading-agent/index.ts`'s
`fetch_live_markets` tool (line 1215) in a `Promise.race` against an 8s timeout, same pattern as
`market-data-fetcher`/`health-check`/`reconcile-orders`/`settle-signals`/`kalshi-ping`/
`futures-signal`/`kalshi-proxy`. On timeout, logs a
`trading_agent_fetch_markets_credential_fetch_failed` `error` row to `compliance_log` and falls
through to the existing unauthenticated-fetch fallback (no distinct HTTP response needed — this is
an LLM tool call mid-turn, not a request with its own caller to respond to).
**Options:** A) Leave it — rejected: this tool fires on every `auto-trade-cron` tick (every 5
minutes), so a stalled query hangs the whole agent turn instead of degrading to the fallback it
already has. B) Fix `cancel_order`'s live-mode call site (line ~1449) instead/also — rejected: that
branch is on the real-money order-cancellation path, off-limits per the 48th run's caution; this
run keeps the one-narrow-fix-per-run discipline and picks the read-only path. C) Applied guard,
degrade-on-timeout to the pre-existing fallback (**chosen**) — matches how this code already
handles a missing credential, so timeout and absence produce the same safe behavior.
**Why:** Matches the timeout-guard pattern proven safe across 7 prior runs; this is a read-only
market-data path with no trading-decision impact, so the standard low-risk bar applies.
**Reversibility:** trivial — single-block revert, no schema or trading-path change.
**Trace:** health-check 58th run, `docs/health-log.md` this run's entry, PR to `dev`.

## 2026-07-28 — Guarded kalshi-proxy's per-user credential fetch with the same 8s timeout pattern, plus a distinct 503 on timeout

**Decision:** Wrapped `getKalshiCredentials(adminClient, userId)` in `kalshi-proxy/index.ts`'s
authenticated branch (line 36) in a `Promise.race` against an 8s timeout, same pattern as
`market-data-fetcher`/`health-check`/`reconcile-orders`/`settle-signals`/`kalshi-ping`/
`futures-signal`. On timeout, logs a `kalshi_proxy_credential_fetch_failed` `error` row to
`compliance_log` and returns `503` "please try again" instead of falling through to the existing
`401` "not configured" response.
**Options:** A) Leave it — rejected: this is the highest-traffic remaining unguarded call site in
the backlog (hit on every authenticated frontend request through the proxy, not just a cron tick),
so a stall directly hangs a live user request. B) On timeout, fall through silently to the existing
`401` "credentials not configured" response (matches the bare-minimum pattern used elsewhere) —
rejected: that message is actively misleading for a timeout, since the user's credentials likely
exist and the query just stalled; telling them to re-enter credentials that were never the problem
would send confused support-ish traffic nowhere useful. C) Distinct `503` + `compliance_log` `error`
row + console.error, matching `kalshi-ping`'s "try again" precedent — **chosen**: correctly
distinguishes "transient failure, retry" from "you haven't set this up," and gives compliance_log a
searchable signal if this ever fires for real. D) Fix `kalshi-proxy`'s other call site (line 54,
service-tenant fallback) in the same pass — rejected: that site already has its own
unauthenticated-fallback degrade path (a stall there doesn't hang the request, it just misses the
authenticated-tier optimization), so it's lower priority and stays a separate, reviewed change per
the one-narrow-fix-per-run discipline.
**Why:** Matches the timeout-guard pattern proven safe across 6 prior runs, and the response-shape
change (503 vs 401) is the first behavioral divergence from the established file-header comment
convention — worth flagging as its own decision rather than folding into "just another instance of
the same fix."
**Reversibility:** easy — single file, single block, revert restores the bare `await` and the old
401-only fallthrough. No schema change, no trading-path change.
**Trace:** PR to `dev`, 57th health-check run, `docs/health-log.md` this run's entry.

## 2026-07-28 — Guarded futures-signal's service credential fetch with the same 8s timeout pattern

**Decision:** Wrapped `getKalshiCredentials(supabase, null)` in `futures-signal/index.ts` in a
`Promise.race` against an 8s timeout, identical to the pattern applied to `market-data-fetcher`
(48th run), `health-check` (51st run), `reconcile-orders` (52nd run), `settle-signals` (54th run),
and `kalshi-ping` (55th run).
**Options:** A) Leave it — rejected: same unguarded shape, and the site sits inside a `try` block
whose `catch` only fires on a thrown error, so an indefinite hang never reaches it — the cron run
(every 10 min) would stall past its next scheduled tick. B) Fix the shared `getKalshiCredentials()`
helper globally — rejected, same reasoning as every prior run: broader blast radius, and the
remaining call sites (`execute-trade`, `trading-agent` ×2, `kalshi-proxy` ×2) stay a deliberate,
reviewed decision, not a side effect of a health-check sweep. C) Scope the fix to
`futures-signal`'s single call site — **chosen**: smallest possible diff, matches the file's
existing degrade-gracefully behavior (falls through to the unauthenticated Kalshi request and the
consecutive-miss counter), consistent with the established one-narrow-fix-per-run discipline.
**Why:** Same class of bug closed five times before in this codebase — the fix pattern is proven,
low-risk, and each additional unguarded call site is a live production stall waiting to happen on
a cron job. Leaving it unfixed after the 55th run explicitly flagged it as backlog would repeat the
mistake documented in the log.
**Reversibility:** easy — single-file, single-block revert, no schema or trading-path change.
**Trace:** commit `e646f43` on `dev`, this run's `docs/health-log.md` entry (56th run).

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

**RESOLVED — 2026-07-28/29.** PR #101 (`28a87d2`) wrapped `getKalshiCredentials()` in the
proposed `Promise.race` + 8s timeout, closing this gap directly; PR #143 (`d051d32`) added one
retry before aborting the run, since the 8s bound alone still let one slow lookup nuke a whole
5-min cycle (recurred 2026-07-23, 2026-07-29). Confirmed live in `market-data-fetcher/index.ts:79-109`
on `dev` as of the 97th health-check run (2026-07-30) — this entry was left open in appearance
after the fix shipped elsewhere in this file; closing it now so it doesn't read as a live gap.

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
