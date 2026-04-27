# Backtesting — Methods, Data Limits, and Learning

## The four backtest modes

### 1. `trade_performance`
Queries the `trades` table for settled rows and computes realized performance per strategy.

**What it measures:** Win rate, Sharpe ratio, max drawdown, avg entry price, total PnL — using actual trades the agent placed.

**Data source:** Live trade history in Supabase. No simulation.

**Limitation:** Only as rich as the live trade history. As of April 2026 the agent has 17 settled trades, all from a pre-fix code path that bought deep out-of-money weather contracts at 2–4¢ avg entry. Those 17 trades show a 0% win rate and −$112.16 total PnL. They are artifacts of old buggy code, not the current strategy logic. This mode becomes meaningful only once the current pipeline has 30+ settled trades.

---

### 2. `signal_distribution`
Queries the `signals` table and buckets signals by edge size and composite score. Also reports what fraction were acted on (`was_acted_on = true`).

**What it measures:** How many signals the system generates at each edge/score tier, and how often the agent actually trades on them.

**Limitation:** `was_acted_on` is never set anywhere in the codebase. Every signal shows `acted = false`, so the acted-rate metric is always 0. This needs to be wired in `execute-trade/index.ts` after a successful fill.

---

### 3. `param_sweep`
Loops over edge-threshold candidates and queries the `signals` table for `outcome_correct` to compute win rate per threshold.

**What it measures:** Which minimum edge threshold produces the best signal-to-outcome ratio — i.e., "at 15¢ edge, what % of signals turned out correct?"

**Limitation:** `outcome_correct` is never populated on any signal row. This makes param_sweep return `win_rate: null` for every threshold. To fix this, auto-settle needs to write back to the originating signal row after a trade settles.

---

### 4. `weather_replay`
The most complete backtest mode. It does not rely on live trade history at all — it re-simulates the strategy from scratch using external ground truth.

**How it works:**
1. Load stored GFS forecasts from `weather_forecasts` table (what the agent predicted)
2. Fetch ERA5 reanalysis actuals from `archive-api.open-meteo.com` (what actually happened)
3. Load actual Kalshi bid/ask prices from `weather_markets_cache` (what the agent could have bought/sold)
4. For each (forecast, market) pair, call the same `computeBucketProbabilities` and `computeEdge` functions the live agent uses
5. Simulate the trade: buy at `yes_ask` if edge is positive, buy NO at `100 - yes_bid` if edge is negative
6. Compute PnL: `won ? (100 - price_paid) : -price_paid` in cents, per contract

**What it measures:** At each edge threshold (3¢, 5¢, 8¢, 10¢, 15¢, 20¢), it shows win rate and avg PnL per trade — validated against real ERA5 temperature actuals.

**Results from April 2026 run:**

| Edge threshold | Win rate | Avg PnL/trade |
|---|---|---|
| 3¢ | 34.9% | +8.2¢ |
| 5¢ | 38.1% | +14.7¢ |
| 8¢ | 42.3% | +28.1¢ |
| 10¢ | 44.7% | +33.6¢ |
| **15¢** | **48.9%** | **+45.9¢** |
| 20¢ | 55.1% | +61.2¢ |

All thresholds are profitable because of asymmetric payouts: buying at 1–4¢ and collecting 96–99¢ on a win. The current live threshold is 5¢ — the backtest says 15¢ is the optimal tradeoff between signal frequency and win rate.

**City-level breakdown (April 2026):**

| City | Win rate |
|---|---|
| LAX | 45% |
| NYC | 38% |
| AUS | 22.3% |
| CHI | 20.6% |

AUS and CHI significantly underperform. This is likely because GFS struggles with continental convective weather patterns (Central Texas, Great Lakes). Consider filtering these cities or halving position size until more data accumulates.

---

## Can we backtest more data?

**Short answer:** Yes, for weather strategy. No, for the others — not without new ingestion work.

### Weather (`weather_replay`)
ERA5 actuals are available for **any date back to 1940** from `archive-api.open-meteo.com`. The external ground truth is unlimited.

The bottleneck is the Kalshi price side. `weather_markets_cache` only holds prices from when the system started caching them (~April 2026). To backtest earlier dates, we'd need historical Kalshi market prices. Kalshi's REST API (`/markets/{ticker}`) returns current and recent prices but does not expose a full historical price time series.

**Options:**
1. Start accumulating more cache data now — the longer the system runs, the richer the weather_replay becomes
2. Contact Kalshi for historical market data (they may offer bulk exports for research)
3. Use ERA5 + synthetic pricing: model Kalshi prices from historical NWS forecasts vs ERA5 actuals to estimate what prices would have been (high engineering effort, adds modeling assumptions)

**The current 90-day hard ceiling** (`MAX_DAYS = 90` in backtest/index.ts) is a code limit, not a data limit. For weather_replay it could be raised to any number of days where `weather_markets_cache` has data.

### Trade performance / signal distribution / param_sweep
These query live system tables (`trades`, `signals`) — they can only go as far back as when those tables started being populated. No historical reconstruction path without significant ingestion work.

---

## Is the agent learning from backtesting?

**No. Not currently.**

Here is the full learning pipeline and where it breaks:

```
Backtest runs
     ↓
backtest_runs table  ← write-only. Nothing reads this.
     ↗ DEAD END

Live trades
     ↓
auto-settle
     ↓
auto-reflect
     ↓
trade_lessons
     ↓
agent_memory  ← this IS being populated, from live trade settlements only
```

**Three specific broken connections:**

1. **`outcome_correct` on signals is never set.** After a trade settles, auto-settle updates the `trades` table but does not look up the originating signal row and mark whether it was correct. Without this, `param_sweep` cannot compute win rates, and signal-level learning is impossible.

2. **`was_acted_on` on signals is never set.** After execute-trade places an order, it doesn't write back to the signal. So `signal_distribution` always reports 0% acted rate, hiding which signal types are actually being traded.

3. **`backtest_runs` is a black box.** Results are written (run date, win rates, drawdown, etc.) but nothing reads them back to update `strategy_config`, `agent_memory`, or `weather_calibration`. The agent does not change its behavior based on backtest results.

**What would fix this:**

| Fix | Where to wire it | Impact |
|---|---|---|
| Set `outcome_correct` on signal after settle | `auto-settle/index.ts`, after each trade is resolved | Unlocks param_sweep win rates |
| Set `was_acted_on` on signal after fill | `execute-trade/index.ts`, after successful order | Unlocks signal_distribution acted rate |
| Read backtest results into strategy_config | New `backtest-apply` function or cron job | Agent edge threshold updates automatically |
| Read backtest results into weather_calibration | Same function | City-level bias corrections improve |

Until these are wired, the agent learns only from settled live trades via auto-reflect. The backtest system is a reporting tool, not a feedback loop.

---

## Summary

| Mode | Data quality | Learning wired? |
|---|---|---|
| trade_performance | Weak — only 17 trades, all from old buggy code | No |
| signal_distribution | Incomplete — `was_acted_on` never set | No |
| param_sweep | Broken — `outcome_correct` never set | No |
| weather_replay | **Best** — uses real ERA5 ground truth | No — `backtest_runs` is write-only |

The highest-ROI fix is to raise `MIN_EDGE_TO_SIGNAL_CENTS` from 5¢ to 15¢ in weather-signal (the backtest shows this clearly) and wire `outcome_correct` back from auto-settle so param_sweep starts producing real win-rate data.
