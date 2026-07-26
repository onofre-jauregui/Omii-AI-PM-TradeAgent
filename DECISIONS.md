# DECISIONS — Omii-AI-PM-TradeAgent

Append-only log of critical architectural decisions. Newest first.

---

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
