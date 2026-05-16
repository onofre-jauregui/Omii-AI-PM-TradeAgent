# TradeAgent — Observability Architecture

**Omii AI · May 2026**

---

## Overview

TradeAgent is a fully autonomous AI trading system operating on Kalshi prediction markets. Every decision it makes — from signal detection to order execution to post-trade reflection — is logged, traced, and measurable. This document describes the observability stack: what is tracked, where it lives, and how it feeds back into the system.

The system runs on Supabase Edge Functions (Deno), with pg_cron driving all automated loops. The observability stack is entirely serverless and scales with the platform.

---

## 1. Error Monitoring — Sentry

**What:** Every edge function is wrapped with a custom Sentry client that captures exceptions and structured messages with full context.

**Captured on every error:**
- Which edge function failed (`auto-trade`, `auto-settle`, `auto-reflect`, etc.)
- Which strategy was active at the time
- The run ID (for correlation across logs)
- Trading mode (paper vs. live)
- Full stack trace

**Severity levels used:** `fatal`, `error`, `warning`, `info`

**Key events captured:**
- Strategy execution failures and LLM timeouts
- Trade settlement errors
- Memory quarantines and compaction failures
- Any unhandled exception in the trading pipeline

**Design principle:** Sentry calls are non-blocking and fire-and-forget. Observability never delays or interrupts trading logic.

---

## 2. LLM Decision Tracing — Langfuse

Every AI decision the agent makes is traceable end-to-end via Langfuse.

**Trace lifecycle per trade:**
1. `traceEvent` fired when an auto-trade run starts
2. `generationEvent` fired for each qualify/reject LLM call — captures the full prompt, full response, model name, token counts, and latency
3. `scoreEvent` fired after the trade settles — links the outcome (win/loss) back to the original qualify decision

**What Langfuse captures per LLM call:**

| Field | Description |
|---|---|
| `traceId` | Links qualify decision → trade → settlement |
| `model` | Which model was used (GPT-4o Mini, Claude, etc.) |
| `prompt` | Full prompt sent to the LLM including market data, memory, and strategy context |
| `completion` | Full LLM response |
| `inputTokens / outputTokens` | Token usage per call |
| `startTime / endTime` | Latency per generation |
| `qualified` | Whether the agent approved the trade |
| `reason` | LLM's stated reasoning |
| `mode` | Paper or live |

**Post-settlement scoring:** When a trade settles, Langfuse receives a score (1 = win, 0 = loss) linked back to the original qualify trace. This enables direct measurement of qualify accuracy over time.

**Outcome:** You can query "what did the agent think before entering this trade, and was it right?" for every trade ever placed.

---

## 3. Compliance Audit Log

Every significant system event writes to a `compliance_log` table — the authoritative audit trail for the platform.

**25+ event types recorded, including:**

| Category | Events |
|---|---|
| **Orders** | `order_submitted`, `order_filled`, `order_cancelled` |
| **Risk checks** | `risk_check_passed`, `risk_check_failed`, `position_limit_hit`, `daily_loss_limit_hit` |
| **Automation runs** | `auto_trade_run`, `auto_trade_strategy_run`, `auto_trade_strategy_error`, `auto_settle_run`, `auto_reflect_run` |
| **Strategy health** | `strategy_suspended_sharpe`, `strategy_suspended_drawdown`, `strategy_suspended_hitrate`, `strategy_loss_streak`, `strategy_resumed` |
| **AI memory** | `memory_quarantined`, `auto_reflect_error` |
| **Settlements** | `trade_settled`, `auto_settle_error` |

Each row includes: `severity` (info/warning/error/critical), `message` (human-readable), `metadata` (JSONB with full context), `trade_id`, `user_id`, and `created_at`.

This table is the answer to: *"What did the system do, when, and why?"*

---

## 4. Trade Audit Trail

Every trade is a first-class auditable record. Each row in the `trades` table captures:

**Execution:**
- Ticker, side (YES/NO), action (buy/sell), price, amount
- Order ID from Kalshi, filled price, filled timestamp
- Strategy ID and name, trading mode (paper/live)

**Decision lineage (v2):**
- `trace_id` — Links to the Langfuse trace of the qualify decision
- `source_signal_id` — Which signal triggered this trade
- `influenced_by_memory_ids` — Which agent memories shaped the decision
- `expiration_time` — When the underlying market settles
- `expected_outcome` — What the agent predicted before entry

**Outcome:**
- `resolution` — How the market resolved (YES, NO, or VOID)
- `pnl` — Realized P&L in dollars
- `settled_at` — Settlement timestamp

**Linked records:**
- `trade_reflections` — Pre/post analysis per trade (expected vs. actual outcome, root cause, decision quality rating)
- `trade_lessons` — Auto-generated lessons from each settled trade
- `memory_attribution` — Which memories were cited in the decision

---

## 5. Agent Memory & Continuous Learning

The agent maintains a persistent, Bayesian memory system. Every trade outcome updates the agent's beliefs.

**`agent_memory` table — the agent's knowledge base:**
- Bayesian priors: `alpha` (wins) and `beta` (losses) updated per settled attribution
- `exposed_confidence` = posterior × 0.5^(age_days/30) — 30-day half-life decay
- Memories only surface to the LLM after ≥5 attributed trades (minimum evidence threshold)
- Memories are **quarantined** (removed from LLM context) if `exposed_confidence < 0.30` after 10+ trades

**`trade_lessons` table — trade-specific retrospectives:**
- Written for every settled trade within a 6-hour window
- Auto-categorized: forecast_bias, market_timing, signal_quality, execution, market_structure
- High-significance lessons (loss at extreme price, |pnl| ≥ $50) promoted to `agent_memory`
- Linked back to the triggering trade and strategy

**`memory_attribution` table — causal chain:**
- Records which memories influenced which trades
- Backfilled with `trade_pnl` at settlement
- Enables answering: *"Did acting on memory X make money or lose money?"*

**`compaction_log` table:**
- Full snapshot of every memory merge/compaction (reversible with `reversed_at` timestamp)

---

## 6. Strategy Health Monitoring

The system continuously evaluates whether each strategy is performing within acceptable bounds. Evaluation runs every 15 minutes via the `auto-reflect` function.

**Metrics calculated per strategy (last 30 settled trades):**
- **Sharpe ratio** — risk-adjusted return
- **Max drawdown** — peak-to-trough decline as a percentage
- **Hit rate** — win percentage
- **Consecutive losses** — trailing count

**Automatic suspension triggers:**

| Condition | Threshold | Suspension |
|---|---|---|
| Sharpe collapse | Sharpe < -1.0, n ≥ 20 trades | 24 hours |
| Drawdown breach | Drawdown > user-set max, n ≥ 10 | 24 hours |
| Hit rate regime shift | Win rate < expected − 20pp, n ≥ 20 | 72 hours |
| Soft warning | ≥5 consecutive losses | Logged, no suspension |

Suspended strategies auto-resume after the window expires. All suspensions are logged to `compliance_log` with full metric context (sharpe, drawdown, hit rate, sample size).

---

## 7. Real-Time Risk State

A `risk_state` table tracks daily risk metrics and serves as the kill switch:

- `daily_pnl` — Today's realized P&L
- `daily_trades` — Count of trades placed today
- `open_position_count` / `open_position_value` — Live exposure
- `max_drawdown_today` — Day's peak-to-trough
- `is_trading_halted` — Master kill switch
- `halt_reason` — Why trading stopped

Every auto-trade run reads `risk_state` before executing. If `is_trading_halted = true`, the entire run aborts and the event is logged. This is the circuit breaker.

---

## 8. Shadow P&L (Skipped Signal Tracking)

The system tracks not just what it traded, but what it **didn't** trade.

For every signal the agent passes on, the `signals` table records `shadow_pnl` — what the P&L would have been if the trade had been taken. This enables the core signal quality metric:

**Qualifier ROI = avg P&L of executed signals − avg P&L of passed signals**

A positive gap means the LLM qualifier is adding value by filtering out losing trades. A negative gap means it's filtering out winners and needs recalibration.

---

## 9. Alerting — Telegram

The `health-check` function runs hourly and sends Telegram alerts for:

| Alert | Trigger |
|---|---|
| Trading silence | No trades placed in 4+ hours while strategies are active and signals exist |
| Win rate collapse | Last 20 settled trades below 70% win rate |
| Strategy suspended | Any strategy auto-suspended by the health monitor |

Alerts include context: last trade timestamp, current win/loss counts, suspension reason and duration.

---

## 10. Concurrency & Race Condition Prevention

The `auto_trade_locks` table provides a distributed lock preventing concurrent auto-trade runs:

- Atomic INSERT on `lock_name = 'auto_trade'`
- Competing insert gets a unique constraint error and exits immediately
- Stale locks (older than 5 minutes) are auto-cleared before each run
- Each lock row carries the `run_id` for correlation with logs

This is implemented as a table lock rather than a PostgreSQL advisory lock because Supabase routes requests through pgbouncer (connection pooling), which breaks session-scoped locks.

---

## What Is Not Yet Instrumented

| Gap | Impact |
|---|---|
| **Frontend error capture** | React exceptions are invisible; no Sentry SDK in the browser layer |
| **Distributed tracing** | auto-trade → execute-trade call chain is not linked by a traceparent header |
| **Structured edge function logs** | `console.log` calls are unstructured; not queryable as JSON |
| **Cron job health monitoring** | No alert if signal-generator or surface-scanner stops producing output |
| **LLM cost aggregation** | Token counts are logged but not aggregated into a daily/strategy cost view |
| **Kalshi API latency** | No monitoring of upstream API health or response times |

---

## Summary

| Layer | Tool | Coverage |
|---|---|---|
| Error monitoring | Sentry (custom Deno client) | All edge functions |
| LLM tracing | Langfuse | Every qualify/reject decision + post-settlement scoring |
| Audit trail | `compliance_log` (Postgres) | 25+ event types, every trade and system event |
| Strategy health | Auto-reflect (15-min cron) | Sharpe, drawdown, hit rate, auto-suspension |
| Agent learning | `agent_memory` + `trade_lessons` | Bayesian confidence, 30-day decay, quarantine |
| Signal quality | `signals.shadow_pnl` | Skipped signal counterfactual P&L |
| Alerting | Telegram bot | Trading silence, win rate, suspensions |
| Concurrency | `auto_trade_locks` (Postgres) | Distributed lock with stale-lock cleanup |
| Risk circuit breaker | `risk_state.is_trading_halted` | Master kill switch, checked every run |
