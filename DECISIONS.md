# DECISIONS — Omii-AI-PM-TradeAgent

Append-only log of critical architectural decisions. Newest first.

---

## 2026-07-25 — Serialized S-001 basket leg submission instead of Promise.all

**Decision:** Changed `auto-trade/index.ts`'s S-001 leg loop from concurrent `Promise.all` to a
sequential `for...of`, with an early-exit once a leg reports `insufficient_balance`.
**Finding:** Scheduled health check found the S-001 basket (`KXINX-26JUL27H1600`) still failing
`insufficient_balance` from 18:15–19:10 UTC — hours after the same-day balance pre-flight fix
(`9d47913`) had deployed. Root cause: submitting all legs concurrently meant each leg's
`GET /portfolio/balance` pre-flight read the same stale snapshot, so every leg passed the check
individually while the basket collectively couldn't be covered; Kalshi's real matching then
rejected the legs the account couldn't actually afford. The same concurrency also saturated the
3/min live `execute-trade` rate limit on one basket.
**Options:** A) Track cumulative reserved collateral across legs in `auto-trade` and pass it into
each pre-flight call — rejected, adds cross-call state and a second source of truth for balance.
B) Serialize leg submission — chosen; each pre-flight then reads Kalshi's real post-previous-leg
balance for free, no new state needed.
**Why:** Simplest fix that removes the race at its source instead of working around it downstream.
**Reversibility:** Easy — one loop, single-function revert (`Promise.all` back in place).
**Trace:** commit `314e10c` on `fix/live-pilot-instrumentation`. `compliance_log`
event_type=`order_failed`/`rate_limit_exceeded`, 2026-07-25 18:15–19:10 UTC.

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
