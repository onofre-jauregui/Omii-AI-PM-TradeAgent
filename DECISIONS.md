# DECISIONS — Omii-AI-PM-TradeAgent

Append-only log of critical architectural decisions. Newest first.

---

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
