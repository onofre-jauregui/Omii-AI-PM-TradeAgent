# Spec: Strategy Cleanup + Test Suite

**Status:** DRAFT — awaiting human review before implementation begins.

---

## Objective

Reduce the agent to three well-evidenced strategies, eliminate the dead-weight strategies
that have no proven edge, and build a test suite that gives us confidence before any real
capital touches the system.

**Why now:** The current system has four strategies but only one with a backtest-validated
edge (weather). The others are either unproven (S-002 signal scanner), dormant (S-004 spread
arb), or generating noise (S-001 macro events). Before inviting users or deploying real money,
we need (a) a clean strategy inventory and (b) tests that catch regressions.

**End state:** Three strategies in production, each with a clear thesis, a green test suite,
and a feedback loop that accumulates real outcome data from day one.

---

## Strategy Inventory (after cleanup)

### S-001 · Weather Signal
_Renamed from S-005. No logic change in this sprint._

- **Thesis:** GFS 31-member ensemble gives us a probability distribution over temperature
  buckets that is occasionally more accurate than Kalshi's implied market price. Trade when
  the gap ≥ 15¢ and the forecast is far from the bucket boundary (reduces noise trades).
- **Edge:** Backtested with ERA5 ground truth. 48.9% win rate at 15¢ threshold, positive EV
  from asymmetric payouts. Small sample (3 weeks) — watch results over 60 days before trusting.
- **Markets:** NYC, LAX, MIA weather high-temperature buckets. AUS/CHI excluded (22-23% win rate).
- **Signal source:** `weather-signal` edge function (runs every 30 min via pg_cron).
- **Changes this sprint:** Rename `strategy_id = "S-005"` → `"S-001"` in DB and all functions.

---

### S-002 · Market Making
_New strategy. No implementation in old codebase._

- **Thesis:** On Kalshi, market makers (resting limit orders) earn positive returns across
  300,000 contracts (QuantPedia). Takers consistently lose. Kalshi's VIP program pays
  $0.005/contract cashback on trades priced 3–97¢ through September 2026, plus daily
  liquidity payouts up to $1,000. Providing liquidity captures the bid/ask spread AND earns
  the rebate, making it a dual-revenue trade.
- **Edge:** Structural (market microstructure + rebate) rather than predictive. Does not
  require forecasting the outcome — only requires managing inventory risk.
- **How it works:**
  1. Scan top 50 liquid Kalshi markets by open interest.
  2. For each, compute a fair-value midpoint using a simple model (volume-weighted recent trades).
  3. Place a YES limit order at `mid - spread/2` and a NO limit order at `mid + spread/2`.
  4. If either fills, place the opposite leg to flatten. If position holds past threshold,
     settle or exit via market order.
  5. Collect Kalshi rebate on both fills.
- **Risk:** Inventory risk if one leg fills and the market moves adversely before the other fills.
  Mitigate with position limits (max $5 exposure per market, max 10 open market-making positions).
- **Signal source:** Inline scan in `auto-trade` — no separate signal function needed.

---

### S-003 · Longshot Fade
_New strategy. No implementation in old codebase._

- **Thesis:** Retail bettors systematically overvalue low-probability outcomes (longshot bias,
  well-documented in behavioral finance). Kalshi contracts priced 5–15¢ win only ~7% of the
  time, not 10–15% as their price implies. Buying NO on these contracts — when no information
  catalyst exists — captures a consistent 3–5¢ EV per trade.
- **Edge:** Behavioral (exploits overpricing of tail events by retail flow).
- **How it works:**
  1. Scan Kalshi markets where YES is priced 5–15¢.
  2. Filter out: election/Fed/payroll days (catalysts), markets open < 24h (price discovery
     not done), markets with <100 contracts volume (illiquid), markets where we hold a position.
  3. For qualifying markets, submit a resting NO limit order at 88–92¢ (i.e., YES ≤ 12¢).
  4. Let Kalshi fill us as retail flow comes in. Do not chase fills.
  5. Hold to settlement. No active exit unless price moves past 20¢ (position sizing stops loss).
- **Risk:** Tail risk — a longshot does occasionally hit. Manage with: max 5% of portfolio per
  position, max 20 open positions, hard stop if YES price crosses 20¢.
- **Signal source:** Inline scan in `auto-trade`.

---

## Strategies Being Retired

| Old ID | Name | Reason |
|---|---|---|
| S-001 | Macro/Surface Arb | LLM-driven, no backtested edge, too slow for prediction markets |
| S-002 | Signal Scanner | Unproven — `outcome_correct` never populated until last session; no win data |
| S-004 | Spread Arb | No order book history, no evidence of edge, rarely fired |

**Retirement plan:**
- Set `is_active = false` in `strategy_config` for old S-001, S-002, S-004.
- Remove their routing branches from `auto-trade/index.ts`.
- Keep their DB rows and trade history (settlement/PnL data is still useful for analysis).

---

## Tech Stack

- **Runtime:** Deno (edge functions), TypeScript
- **Database:** Supabase Postgres + edge functions
- **Test framework:** Vitest (already configured in `vitest.config.ts`)
- **Test environment:** `jsdom` for frontend, `node` (override) for edge function logic
- **Existing tests:** `_shared/weather.test.ts`, `_shared/risk.test.ts`,
  `_shared/encryption.test.ts`, `_shared/billing.test.ts`

---

## Commands

```bash
# Run all tests
npm test

# Run with coverage
npm run test -- --coverage

# Run only edge function tests
npm test -- supabase/functions

# Run specific strategy tests
npm test -- supabase/functions/auto-trade

# Type check
npx tsc --noEmit
```

---

## Project Structure

```
supabase/functions/
  _shared/
    weather.ts              ← S-001 math (existing)
    weather.test.ts         ← existing, expand
    risk.ts                 ← position sizing, stop-loss (existing)
    risk.test.ts            ← existing, expand
    market-making.ts        ← NEW: S-002 fair-value + spread math
    market-making.test.ts   ← NEW
    longshot.ts             ← NEW: S-003 filter logic
    longshot.test.ts        ← NEW
    signals.ts              ← shared signal evaluation helpers (extract from auto-trade)
    signals.test.ts         ← NEW
  auto-trade/
    index.ts                ← strategy router (refactor: remove S-001/S-002/S-004 branches)
    index.test.ts           ← NEW: integration tests with mocked Supabase
  weather-signal/
    index.ts                ← rename strategy_id references
  auto-settle/
    index.ts                ← already updated (outcome_correct wiring)

docs/
  spec-strategy-cleanup-and-tests.md  ← this file
  backtesting.md                       ← existing
```

---

## Test Strategy

### Level 1 — Pure math (unit tests, no I/O)
Test the deterministic functions in `_shared/`. These are already partially tested.
Extend to cover new S-002 and S-003 shared logic.

```typescript
// Example: market-making.test.ts
it("computes fair-value midpoint from recent fills", () => {
  const mid = computeFairValue([{ price: 52, volume: 10 }, { price: 48, volume: 20 }]);
  expect(mid).toBeCloseTo(49.33, 1); // volume-weighted
});

it("rejects market-making opportunity when spread < 3¢", () => {
  expect(qualifyForMarketMaking({ yes_bid: 50, yes_ask: 52 })).toBe(false);
});
```

### Level 2 — Strategy qualification logic (unit tests, mocked DB)
Test the decision logic of each strategy in isolation — does it correctly qualify/reject
signals given different portfolio and market states?

```typescript
// Example: auto-trade/index.test.ts
it("S-003 skips markets open < 24h", async () => {
  const result = await runLongshotFade(mockSupabase({
    markets: [{ ticker: "XYZ", yes_ask: 10, open_date: hoursAgo(12) }]
  }), mockStrategy);
  expect(result.action).toBe("no_setup");
  expect(result.details).toMatch(/< 24h/);
});
```

### Level 3 — Pipeline integration tests (mocked Supabase, real logic)
Test the full auto-trade → signal → trade insertion path with a mocked Supabase client.
Verify that a qualifying signal produces a correctly-structured trade row.

### Level 4 — Backtest regression tests
Run `weather_replay` and `signal_quality` backtest modes against fixture data and assert
that results are within expected ranges (guards against logic regressions).

### Coverage targets
- `_shared/` pure functions: 90%+
- Strategy qualification logic: 80%+
- Pipeline integration: key happy paths + top 3 edge cases per strategy

---

## Code Style

```typescript
// Pure functions in _shared/ — no I/O, no Supabase, fully testable
export function qualifyForLongshotFade(market: KalshiMarket, portfolio: Portfolio): QualifyResult {
  if (market.yes_ask > 15 || market.yes_ask < 5) return { qualify: false, reason: "price_out_of_range" };
  if (hoursOpen(market) < 24) return { qualify: false, reason: "too_new" };
  if (portfolio.hasOpenPosition(market.ticker)) return { qualify: false, reason: "already_held" };
  return { qualify: true };
}

// Strategy handlers in auto-trade — thin orchestration, calls _shared/
async function runLongshotFade(supabase, strategy, config) {
  const markets = await fetchCandidates(supabase);
  const qualified = markets.filter(m => qualifyForLongshotFade(m, portfolio).qualify);
  // ...
}
```

**Conventions:**
- No strategy logic in index.ts directly — extract to `_shared/` so it's testable
- Each `_shared/` module exports only pure functions (no Deno.env, no fetch, no createClient)
- Test files co-located with source (`weather.ts` → `weather.test.ts`)
- `describe` per function, `it` per case, no test file > 200 lines

---

## Boundaries

**Always:**
- Run `npm test` before deploying any edge function
- Keep strategy logic in `_shared/` pure (no I/O) so tests don't need network mocks
- Update `strategy_config` in DB via migration, not manual SQL

**Ask first:**
- Changing position sizing or risk limits in `_shared/risk.ts`
- Adding a new market type that S-002/S-003 would trade
- Modifying how `outcome_correct` is written back (affects all backtest modes)

**Never:**
- Deploy a strategy change without at least one test covering the qualification logic
- Set `is_active = true` for a retired strategy without a written rationale
- Use real Kalshi API in tests (all network calls must be mocked)

---

## Success Criteria

1. `npm test` passes with 0 failures
2. `_shared/market-making.ts` and `_shared/longshot.ts` exist with ≥80% test coverage
3. `auto-trade/index.ts` routes only to S-001, S-002, S-003 — no S-001(old)/S-004/S-005 branches
4. `strategy_config` DB rows: S-001/S-002/S-003 `is_active=true`; old S-001/S-002/S-004 `is_active=false`
5. A qualifying longshot-fade signal produces a correctly-structured paper trade in the integration test
6. A qualifying market-making opportunity produces a correctly-structured limit order in the integration test
7. `weather_replay` backtest still returns win_rate ≥ 0.40 at 15¢ threshold on fixture data

---

## Open Questions (need your answer before planning tasks)

1. **Market making on paper trades:** Kalshi's REST API supports limit orders, but the paper
   trading mode currently only simulates fills instantly. For S-002 to be meaningful, we need
   to either (a) actually submit limit orders to Kalshi in paper mode and wait for fills, or
   (b) simulate a fill model. Which do you want?

2. **S-003 position sizing:** The spec says max $5 per position, max 20 positions ($100 total
   exposure). With a $100 paper portfolio this saturates the account. Should S-003 share the
   overall portfolio limit with S-001, or have its own separate $100 pool?

3. **Timeline for S-002/S-003 implementation:** Market making requires Kalshi limit order
   API calls (authenticated). Do you want S-002 implemented now, or should we build S-003
   first (simpler — just scan + buy NO) and defer S-002?

---

## Implementation Order (proposed — pending spec approval)

```
Phase 1 — Cleanup (no new features, just rename + retire)
  1a. DB migration: rename S-005→S-001, deactivate old S-001/S-002/S-004
  1b. auto-trade: remove old branches, add S-001/S-002/S-003 routing stubs
  1c. weather-signal: update strategy_id references

Phase 2 — Test suite foundation
  2a. Extract strategy qualification logic from auto-trade into _shared/
  2b. Write tests for extracted logic + new S-003 qualifier
  2c. Write auto-trade integration test harness (mock Supabase factory)

Phase 3 — S-003 Longshot Fade implementation
  3a. _shared/longshot.ts — pure qualification logic
  3b. _shared/longshot.test.ts — full coverage
  3c. auto-trade S-003 handler — thin orchestration
  3d. auto-trade/index.test.ts — S-003 integration test

Phase 4 — S-002 Market Making (after S-003 is live and generating data)
  4a. _shared/market-making.ts — fair-value + spread logic
  4b. _shared/market-making.test.ts
  4c. auto-trade S-002 handler
  4d. Integration test
```
