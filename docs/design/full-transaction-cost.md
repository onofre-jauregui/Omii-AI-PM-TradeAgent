---
version: 1
updated: 2026-07-23
status: draft
---

# Full Transaction Cost & Cost Observability — Design

**Branch:** `worktree-feat+full-transaction-cost-tracking` (isolated worktree)
**Motivation (Onofre, 2026-07-23):** "The cost should be the total amount of a successful transaction, not just the api cost." The observability system should be the source of truth for what a trade *actually* costs — end to end, net of every fee and every attributable AI call — because that is the track-record artifact the whole product thesis (and the family-capital unlock) depends on being honest.

---

## 1. The problem this fixes

Two independent gaps make the current "profitability" picture optimistic:

1. **Stored P&L is gross, not net.** `computePnl` (`_shared/trading-logic.ts:32`) computes `contracts × (1 − price)` on a win and `−contracts × price` on a loss, and **never subtracts the Kalshi trading fee**. Kalshi charges `round_up(0.07 × contracts × P × (1−P))` per contract on the taker side (peaks at 1.75¢/contract at 50¢, ~0.63¢ at 90¢) — real money off every fill. The `trades.pnl` column, the leaderboard, the performance page, and the win-streak logic all read this gross number. Every profitability claim the system makes is currently overstated by the fee it never booked.

2. **AI cost is only partially tracked, and never tied to the trade it paid for.** After the `fix/llm-cost-observability` merge (PR #27), all 6 live LLM call sites now log `llm_usage` to `compliance_log` with real token counts. But that data is aggregated platform-wide on the Observability page — it is **not linked to the individual trade** whose decision it funded, so you cannot answer "what did *this* transaction cost me, all in."

"Full transaction cost" = **Kalshi fees + attributable AI cost**, subtracted from gross P&L to get the number that actually matters: **net realized profit per trade.**

---

## 2. Cost components (what goes into the total)

| Component | Source | Per-trade attributable? | Typical magnitude |
|---|---|---|---|
| **Kalshi entry fee** | `round_up(0.07 × C × P × (1−P))` at fill price | **Yes** — direct, deterministic from fill | dominant cost; ¢ to $ per basket |
| **Kalshi exit fee** | same formula, if the position is sold before settlement rather than held to resolution | Yes — only when an exit trade fires (`exit_reason` set) | often $0 (most positions held to settle) |
| **Direct AI qualify cost** | the `llm_usage` row for this trade's qualify call (`trace_id` link) | **Yes** for S-002/S-005 (they call the LLM); **$0 for S-001** (rule-based, `no LLM gate needed`) | ~$0.0001/call at gpt-4o-mini |
| **Amortized upstream AI** | signal-generation, auto-reflect, compact-memory runs — each serves many trades, not one | **No** — genuinely shared; see §4 | small, but real and recurring |
| **Settlement/infra** | Supabase compute, pg_cron | No — flat platform overhead | negligible, not modeled |

---

## 3. Verified numbers (grounding, not estimates)

- **AI qualify cost:** 659 real logged qualify calls (2026-06-01 → 07-07), avg 725 in / 32 out tokens on `gpt-4o-mini` → **$0.000128/call**. This is a rounding error next to Kalshi fees on any real-money trade.
- **Kalshi fee, worked example:** the 07-17 S-001 basket filled 6 NO legs at 85–91¢. At 91¢: `0.07 × 1 × 0.91 × 0.09 = 0.0057` → rounds up to **1¢/contract**. On a $15 leg (~16 contracts at 91¢) that's ~16¢ entry fee — **>1000× the AI cost of the same trade.** The fee is the transaction cost; the API is noise. This is exactly why Onofre's reframing matters: tracking only API cost measures the wrong thing by three orders of magnitude.

---

## 4. The one real design decision — how to attribute *shared* AI cost

Direct costs (Kalshi fee, this trade's own qualify call) attribute cleanly. The fork is what to do with **shared** AI runs (signal generation scores hundreds of markets; auto-reflect and compact-memory run hourly over the whole book):

**Option A — Two-layer (recommended).** Per-trade net P&L subtracts only *directly attributable* cost (Kalshi fees + this trade's own qualify call). Shared AI runs (signal-gen, reflect, compaction, chat) are tracked as a **separate platform-level AI-overhead line** in the cost dashboard — real, visible, summed over time, but not force-divided onto individual trades.
- *Why:* it keeps per-trade net P&L clean and defensible (every cent traceable to that trade), while still surfacing total platform AI spend. Forcing a global compaction run's cost onto whatever trades happened to settle that hour produces a noisy, arbitrary per-trade number that misleads more than it informs. And at gpt-4o-mini volumes the shared AI is tiny — precision here buys nothing.

**Option B — Full amortization.** Divide every shared run's cost across the trades it plausibly touched (e.g. signal-gen cost split across signals it produced that led to fills). Per-trade net P&L then reflects total loaded cost.
- *Why not (default):* high implementation complexity and fragile attribution logic (which trades did an hourly compaction "serve"?), for a cost that is currently ~0.1¢/call. Revisit only if AI spend ever grows to a material fraction of Kalshi fees — at which point a bigger model or higher volume would be the trigger.

**Recommendation: A.** Clean per-trade net P&L + a separate honest platform-AI-overhead total. Ship the thing that makes the track record correct (net of Kalshi fees) first; treat shared-AI amortization as a later refinement only if the numbers ever justify it.

---

## 5. Proposed data model (Option A)

Add to `trades` (all nullable, backfillable):
- `entry_fee_cents INTEGER` — Kalshi taker fee booked at fill, from the fee formula on actual fill price/size.
- `exit_fee_cents INTEGER` — fee on an exit trade if one fired; `0`/null when held to settlement.
- `ai_qualify_cost_usd NUMERIC` — cost of this trade's own qualify LLM call (join via `trace_id` → the `llm_usage` row); `0` for S-001 (rule-based, no LLM).
- `net_pnl NUMERIC` — **derived, the headline number:** `pnl − (entry_fee + exit_fee)/100 − ai_qualify_cost_usd`. Written at settlement alongside the existing gross `pnl` (keep gross too — don't destroy the existing series).

Platform-AI-overhead: no new table needed — it's already in `compliance_log` as `llm_usage` rows; the dashboard sums the ones **not** tied to a settled trade's `trace_id` as the shared-overhead line.

**Fee source of truth:** compute from the verified formula at fill time, and — where the Kalshi order response returns a fee field — reconcile against it (the live `execute-trade` order path does not currently capture a fee from the response; that capture is part of this work). Paper trades compute the same formula so paper and live P&L are comparable.

---

## 6. Scope of this branch (proposed, for sign-off before code)

1. Correct the fee model everywhere it's assumed (the S-001 hurdle math uses a flat 7%-of-winnings approximation at `auto-trade/index.ts:1028`; the real formula is per-contract `0.07·C·P·(1−P)`).
2. Book `entry_fee_cents` on every fill (paper + live) in `execute-trade`; capture the live fee from the Kalshi order response where present and reconcile.
3. Compute and store `net_pnl` at settlement in `auto-settle`, subtracting fees + direct AI qualify cost; keep gross `pnl` intact.
4. Link `ai_qualify_cost_usd` per trade via `trace_id` → `llm_usage`.
5. Surface on the Observability page: net-of-cost P&L, a cost-breakdown (Kalshi fees vs direct AI vs platform AI overhead), and the platform-AI-overhead line for shared runs.
6. Backfill historical trades where possible (fees are recomputable from stored fill price/size; historical direct AI cost only where a `trace_id` link exists).

**Open for Onofre:** confirm Option A (two-layer) vs B (full amortization) before any schema/code — it determines the data model. Everything else follows from that call.
