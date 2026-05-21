# OMII Trade Agent — Production System Report

**Version:** 2.0 | **Exchange:** Kalshi Prediction Markets | **Date:** May 2026

---

## 1. Architecture

### Layer Separation

The system is organized into four discrete layers with no cross-layer coupling:

| Layer | Technology | Role |
|---|---|---|
| Presentation | React 18 / Vite / TypeScript on Vercel | Dashboard, onboarding, observability UI |
| Orchestration | Supabase Edge Functions (Deno runtime) | Strategy execution, trade routing, signal ingestion |
| Persistence | PostgreSQL (Supabase managed) | Trades, signals, memory, audit logs, risk state |
| Scheduling | pg_cron + pg_net | Autonomous event loops with no external scheduler dependency |

### Signal and Execution Pipeline

```
Market Data (Kalshi API)
    │
    ├── surface-scanner [30s]   → surface_alerts table
    ├── signal-generator [1m]   → signals table
    └── weather-signal [10m]    → weather_forecasts + signals table

auto-trade [2m]
    │
    ├── Load active user strategies (RLS-scoped per user)
    ├── Read strategy_config (edge thresholds, position limits)
    ├── Risk pre-check (risk_state + risk_settings)
    ├── Route by template_id → S-001 | S-002 | S-005
    │
    └── Per strategy:
         ├── S-001 Surface Arb   → structural bracket-sum violation → NO LLM gate
         ├── S-002 Longshot Bias → signals query → LLM qualify/reject → execute
         └── S-005 Weather Edge  → NWS divergence → LLM gate (bypass ≥25¢ edge)

execute-trade [called per opportunity]
    │
    ├── Liquidity check (orderbook depth)
    ├── Risk evaluation (pure, deterministic, no I/O)
    ├── Paper: simulated fill → DB write
    └── Live: HMAC-signed Kalshi API order → DB write + compliance log

auto-settle [10m] → reads settled Kalshi markets → writes pnl to trades
auto-reflect [1h] → synthesizes trade outcomes → agent_memory lessons
```

### LLM Usage — Deterministic Orchestration Pattern

The LLM makes **one decision per opportunity**: qualify or reject. All other decisions — what to look at, sizing, risk limits, execution path — are enforced deterministically in code. This eliminates the core failure modes of prompt-based orchestration (LLM skipping risk checks, hallucinating opportunities, using the wrong execution path).

The qualify call runs through OpenRouter with a configurable model (gpt-4o-mini default). Timeout is 15 seconds; if the LLM fails, the opportunity is skipped — it never blocks the pipeline.

### Multi-Tenancy

Every database table with user data enforces Row Level Security: `user_id = auth.uid()`. Edge functions use the service role key (bypasses RLS) and manually enforce tenant isolation on every query. User strategies are scoped to user_id; trades are written with user_id; each user sees only their own data. System-level data (signals, surface_alerts) is shared read-only.

---

## 2. Reliability

### Concurrency Lock

`auto-trade` uses an atomic table-based lock (`auto_trade_locks`) to prevent concurrent invocations. Lock acquisition is a single `INSERT` — if a lock row already exists (unique constraint), the second invocation exits immediately. Stale locks (>5 minutes) are cleaned up before re-inserting. This eliminates the race condition present in `SELECT → UPSERT` patterns.

### Circuit Breaker — Per-Strategy Kill Switch

`strategy_config` tracks `consecutive_failures` per strategy. Thresholds are configurable:

- **Warning:** 3 consecutive failures → Telegram alert
- **Suspension:** 10 consecutive failures → `is_halted = true`, `halt_reason` written
- **Auto-resume:** configurable `suspended_until` timestamp

Once halted, `auto-trade` skips the strategy on every tick and logs a `auto_trade_strategy_halted` compliance event. The kill switch resets automatically on any successful run (non-`no_setup` result). Manual reset is available via SQL or the dashboard.

### Global Kill Switch

`risk_state.is_trading_halted` halts all trading platform-wide. Set automatically when the daily loss limit is breached. Logged to `compliance_log` with `severity: critical`. Requires manual reset.

### Liquidity Fallback

Before every execution, `execute-trade` checks the Kalshi orderbook for sufficient depth at the target price. If depth is insufficient, it falls back to a limit order at the target price rather than rejecting the trade entirely. Logged as a compliance event.

### LLM Fault Tolerance

All LLM calls are wrapped with `Promise.race` against a 15-second timeout. If the call fails or times out, the opportunity is skipped — never retried in the same run. The compliance log records all LLM decisions with the full prompt hash and outcome, so missed opportunities are auditable.

### Automated Settlement

`auto-settle` runs every 10 minutes. It queries Kalshi for final market outcomes and writes `pnl` to settled trades. Paper trades compute P&L against the final YES price. Live trades use actual fill prices. Settlement is idempotent — re-running does not double-credit P&L.

---

## 3. Observability

### Distributed Tracing — Langfuse

Every `auto-trade` invocation creates a Langfuse trace with a unique `run_id`. Each LLM call generates a child generation event tagged with:
- Model name (provider prefix stripped for cost lookup)
- Input/output token counts
- Prompt and completion text
- Strategy ID and trade ticker

Langfuse provides per-model cost aggregation, latency histograms, and prompt versioning. The `CostReport` admin page surfaces daily cost breakdowns pulled from Langfuse.

### Error Tracking — Sentry

All edge functions ship a zero-dependency Sentry client (`_shared/sentry.ts`). It uses the Sentry Envelope API directly — no SDK, no startup overhead, fire-and-forget (never blocks the critical path). Every uncaught exception is captured with:
- Full stack trace
- Function name, strategy ID, run ID
- Trading mode (paper vs live)

`captureMessage` is used for structured non-exception events (strategy halts, risk breaches).

### Compliance Log

`compliance_log` is the system-of-record for every consequential event. Every row has: `event_type`, `severity` (info / warning / error / critical), `message`, `metadata` (JSONB), `user_id`, `trade_id`, and timestamp.

Key event types logged:

| Event | Severity |
|---|---|
| `auto_trade_strategy_run` | info |
| `auto_trade_strategy_halted` | warning |
| `strategy_auto_halted` | error |
| `risk_check_failed` | warning |
| `risk_trading_halted` | critical |
| `liquidity_fallback` | warning |
| `trade_executed` / `trade_rejected` | info |
| `unknown_strategy_skipped` | warning |

### Observability Dashboard

Live system health is surfaced at `/observability`. Displays: cron job last-run times, compliance log stream (filterable by severity), strategy halt status, risk state, and active position counts.

### Operational Alerts — Telegram

Real-time alerts are sent to a private Telegram channel for: production errors (via Sentry integration), strategy auto-halts, and health-check anomalies. Alert format: `[TradeAgent] <severity>: <message>`.

### Health Check

`health-check` runs hourly via pg_cron. Validates: database connectivity, edge function reachability, cron job staleness (alerts if any job hasn't run in >2× its expected interval), and strategy config sanity.

---

## 4. Security

### Credential Encryption — AES-256-GCM

User API keys (Kalshi RSA private keys) are encrypted at rest using AES-256-GCM via the Web Crypto API (`_shared/encryption.ts`). The master key lives exclusively in Supabase Vault as `API_KEY_ENCRYPTION_KEY` — it is never stored in the database. Each encryption operation generates a unique 96-bit random nonce. Storage format: `secret_ciphertext` (base64 ciphertext) + `secret_iv` (base64 nonce) in the `api_keys` table.

### Kalshi API Authentication — HMAC-SHA256

All Kalshi API calls use RSA-based request signing as required by the Kalshi v2 API specification. The `_shared/kalshi-auth.ts` module generates `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, and `KALSHI-ACCESS-SIGNATURE` headers on every request. Private keys are decrypted in-memory per request and never logged.

### Row Level Security

All user-facing tables (`trades`, `strategies`, `profiles`, `api_keys`, `agent_memory`) enforce Postgres RLS policies. The policy on every table: `user_id = (auth.uid())::text`. Edge functions use the service role key (RLS bypass) and enforce isolation manually on every query — `user_id = strategy.user_id` filters appear on all trade reads and writes.

### Stripe Webhook Verification

Stripe webhooks are verified using HMAC-SHA256 signature validation (`_shared/billing.ts`). The signed payload is `{timestamp}.{raw_body}`. Replay attacks are rejected by enforcing a 300-second timestamp tolerance. Events that fail verification return 400 with no processing.

### Input Validation

Every edge function validates all inputs at the boundary before processing. Required fields are checked before any database operation. Strategy IDs are validated against an explicit allowlist before routing — unknown strategies are logged and rejected, never silently passed to an LLM.

### Secret Management

All production secrets live in Supabase Vault (encrypted KMS-backed storage). No secrets appear in source code, environment files, or logs. The `~/.omii_env` master file is the local source of truth and is excluded from all version control.

---

## 5. Compliance

### Audit Trail

`compliance_log` provides an immutable event trail for every system action. Entries are append-only (no updates, no deletes). Every trade decision includes: strategy rationale, confidence level, expected outcome, entry/exit reason, and the LLM's qualify/reject reasoning. This supports post-hoc review of any position.

### Risk Controls — Layered Enforcement

Risk is enforced in two independent layers:

**Layer 1 — Pre-trade (execute-trade):**
- Maximum position size per trade (configurable per tenant)
- Maximum open positions (tier-gated: 2 free / 8 starter / 25 pro / 100 prop)
- Daily loss limit (absolute dollar cap)
- Maximum drawdown (% of peak portfolio value)
- Single-order concentration limit (>25% of portfolio triggers rejection)

**Layer 2 — Strategy-level (strategy_config):**
- Minimum edge threshold (cents) before a signal qualifies
- Minimum liquidity score
- Maximum and minimum days to resolution
- Maximum concurrent legs per event (S-001)

Paper mode bypasses Layer 1 risk checks entirely — simulated trades are unrestricted. Layer 2 thresholds apply in both modes.

### Human in the Loop

The LLM qualify/reject call is advisory. Code-level risk limits are enforced unconditionally regardless of LLM output. An LLM that says "QUALIFY" on a position that exceeds the daily loss limit is still rejected. The system logs both the LLM decision and the override when they diverge.

The strategy_config `is_halted` flag requires **manual intervention** to reset — the system never auto-restarts a halted strategy without a human reviewing the halt reason.

### Data Residency

| Data | Location |
|---|---|
| Database (trades, profiles, memory) | Supabase managed Postgres — us-east-1 (AWS) |
| Edge function execution | Supabase Edge Runtime (Deno, globally distributed) |
| Frontend serving | Vercel CDN (globally distributed) |
| LLM inference | OpenRouter → provider data centers (US) |
| Error tracking | Sentry (US region) |
| LLM tracing / cost | Langfuse Cloud (EU, GDPR compliant) |

No PII (name, email, financial account numbers) is passed to LLMs. Prompts contain only market data: tickers, prices, edges, historical win rates. User emails are stored in Supabase Auth only.

### Subscription Enforcement

Tier limits (max trades/day, max open positions, max position size, strategy access) are enforced server-side in `execute-trade` — never trusted from the client. Live trading requires an active/trialing subscription status. Paper trading is unrestricted for all authenticated users.

---

## 6. Operations

### Deployment Pipeline

**Frontend (React):**
```
git push main → GitHub → Vercel CI → auto-deploy → CDN invalidation
```
Build time: ~45 seconds. Rollback: `vercel rollback` promotes previous deployment instantly.

**Edge Functions (Deno):**
```
npx supabase functions deploy <function-name> --project-ref <ref>
```
Deploy time: ~15 seconds per function. Functions are versioned; rollback deploys the prior artifact. Shared modules (`_shared/`) are bundled per-function at deploy time.

**Database Migrations:**
Applied via the Supabase Management API (`POST /v1/projects/{ref}/database/query`). `supabase db push` is disabled — migrations are applied as explicit SQL via the API to maintain a full execution log. Each migration is a numbered file in `supabase/migrations/`.

### Scheduled Jobs (pg_cron)

| Job | Schedule | Function |
|---|---|---|
| `surface-scanner-cron` | Every 30 seconds | Scan Kalshi bracket markets for structural mispricings |
| `auto-trade-cron` | Every 2 minutes | Execute strategies for all active users |
| `signal-generator-cron` | Every minute | Score and store fresh market signals |
| `auto-settle-cron` | Every 10 minutes | Settle resolved markets, write P&L |
| `weather-signal-cron` | Every 10 minutes | Compare NWS forecasts to Kalshi weather markets |
| `futures-signal-cron` | Every 10 minutes | Score futures-based signals |
| `auto-reflect-hourly` | Every hour | Consolidate trade outcomes into agent memory lessons |
| `health-check-hourly` | Every hour | Validate system health, alert on anomalies |
| `backtest-weather-daily` | Daily at 6 AM | Rolling 30-day weather model calibration |

### Runbook — Strategy Auto-Halt

**Symptom:** No new trades from a strategy. Compliance log shows `strategy_auto_halted`.

1. Query halt state: `SELECT id, is_halted, halt_reason, consecutive_failures FROM strategy_config WHERE is_halted = true`
2. Review last 10 errors: `SELECT message, metadata, created_at FROM compliance_log WHERE event_type = 'auto_trade_strategy_run' AND metadata->>'status' = 'error' ORDER BY created_at DESC LIMIT 10`
3. Diagnose root cause from `halt_reason` (last error message is included)
4. Fix underlying issue (bad signal, API timeout, schema mismatch)
5. Reset: `UPDATE strategy_config SET is_halted = false, consecutive_failures = 0, halt_reason = null WHERE strategy_id = '<id>'`
6. Monitor compliance_log for the next 2 cron ticks to confirm recovery

### Runbook — Global Trading Halt

**Symptom:** All trading stopped. `risk_state.is_trading_halted = true`.

1. Query: `SELECT date, is_trading_halted, halt_reason, daily_pnl FROM risk_state WHERE date = current_date`
2. Review recent P&L to understand trigger
3. Assess whether halt is warranted (daily loss limit, drawdown) or false positive
4. Reset: `UPDATE risk_state SET is_trading_halted = false, halt_reason = null WHERE date = current_date`
5. Optionally adjust limits: `UPDATE risk_settings SET max_daily_loss = <new_value>`

### Runbook — Deploy Rollback (Edge Function)

```bash
# List recent deployments
npx supabase functions list --project-ref uyfnezxmgwitpzsrnkst

# Re-deploy previous version from git
git checkout <previous-commit> -- supabase/functions/<function-name>/
npx supabase functions deploy <function-name> --project-ref uyfnezxmgwitpzsrnkst
git checkout HEAD -- supabase/functions/<function-name>/
```

Edge function deploys take effect immediately on the next invocation — pg_cron jobs pick up new code on their next tick without restart.

### Test Coverage

Unit tests run under Vitest (Node-compatible) covering:
- `billing.ts` — all tier entitlement paths, paper mode bypass, Stripe signature verification
- `risk.ts` — all six risk rejection codes, paper mode passthrough, limit boundary conditions
- `encryption.ts` — AES-256-GCM round-trip, wrong-key rejection, IV uniqueness
- `weather.ts` — NWS probability-to-edge conversion, city dedup, mid-price filter

Run: `npx vitest run supabase/functions/_shared/`

---

*This document reflects the production system as of May 2026. All architecture claims are derived from deployed code.*
