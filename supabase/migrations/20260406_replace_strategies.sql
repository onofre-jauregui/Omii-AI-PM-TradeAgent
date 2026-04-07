-- Replace placeholder strategies with four actionable, revenue-generating strategies
-- designed specifically for Kalshi prediction markets.
--
-- Each strategy has a distinct alpha source, specific entry/exit rules,
-- and is designed to work with the signal generator and surface scanner tools.

INSERT INTO public.strategies (id, name, description, instructions, active, mode, starting_balance)
VALUES

-- ─── S-001: Surface Arbitrage ─────────────────────────────────────────────────
-- Exploits structural inconsistencies between related markets.
-- Near-riskless when monotonicity violations are present.
(
  'S-001',
  'Surface Arbitrage',
  'Exploit structural price inconsistencies between related Kalshi markets — monotonicity violations, bracket sum gaps, and spread anomalies detected by the surface scanner.',
  E'You are executing the Surface Arbitrage strategy. Your edge comes from structural misfires between related markets, not from predicting outcomes.\n\nSTEP 1 — SCAN FIRST\nAlways start by calling scan_surface. Do not look at individual markets before you have the alert list.\n\nSTEP 2 — PRIORITIZE BY TYPE\nWork alerts in this order:\n1. monotonicity_violation — highest priority. A lower threshold market priced cheaper than a higher threshold market is near-riskless. Example: "BTC > $50k" YES at 32¢ and "BTC > $55k" YES at 38¢. Buy YES on the lower threshold immediately.\n2. bracket_sum_violation (underpriced) — sum of YES prices < 85¢ across MECE outcomes. Buy the 1–2 most liquid underpriced markets in the event.\n3. spread_anomaly — post a limit order 1¢ inside the mid on both sides to capture the spread.\n\nSTEP 3 — SIZING\n- Monotonicity violations: size up to $50 per leg. These are structural and close fast.\n- Bracket violations: $25–$30 per market. These are slower to converge.\n- Spread anomalies: $15–$20. Use limit orders only, never market orders.\n\nSTEP 4 — EXIT RULES\n- Monotonicity arb: exit when the spread closes to < 3¢ or at resolution.\n- Bracket violations: exit when sum of YES prices returns to 95–105¢ range.\n- Spread anomalies: cancel if market moves > 5¢ from your entry mid before fill.\n\nSTEP 5 — WHAT TO AVOID\n- Do not trade alerts with confidence < 0.3.\n- Do not trade markets expiring in < 2 hours (spreads widen erratically near close).\n- If scan_surface returns zero alerts, skip this session — do not improvise.\n\nAfter each trade: save_insight with what you exploited and the edge size. Tag "surface_arb". This builds a memory of which series produce the most consistent violations.',
  true,
  'paper',
  1000
),

-- ─── S-002: Resolution Fade ───────────────────────────────────────────────────
-- Fades overreaction moves in markets 2–7 days from resolution.
-- Alpha source: participants in prediction markets consistently overweight
-- recent news and underprice base rates near resolution dates.
(
  'S-002',
  'Resolution Fade',
  'Fade overreaction price moves in markets 2–7 days from resolution. Prediction market participants systematically overreact to recent news near expiry — this strategy trades mean reversion back to base rates.',
  E'You are executing the Resolution Fade strategy. Your edge comes from systematic participant overreaction in the final days before a market resolves.\n\nCORE THESIS\nIn the 2–7 day window before resolution, Kalshi market prices frequently overshoot on news events. A 20¢ price move driven by a single headline in a market that was stable for weeks is usually a fade — the base rate pulls the price back before expiry. You take the other side of those moves.\n\nSTEP 1 — FIND CANDIDATES\nCall fetch_signals with no category filter. Filter to signals where:\n- time_value_score >= 0.7 (resolves within 7 days)\n- edge_score >= 0.4 (price is at an extreme, not near 50¢)\n- Signal direction matches an extreme: buy_yes means price < 25¢, buy_no means price > 75¢\n\nSTEP 2 — QUALIFY THE SETUP\nFor each candidate, call fetch_live_markets with that specific series. You need to judge:\n- Is the price extreme due to a legitimate, game-changing fundamental event? (e.g., actual Fed decision announced, actual jobs number released) → SKIP. Do not fade confirmed fundamentals.\n- Is the price extreme due to a speculative news story, analyst opinion, or social media sentiment? → FADE. These move the market but not the actual probability.\n- What was the price 3–5 days ago? If the market has been at 30¢ for weeks and just moved to 12¢ on a rumor, the expected value is to buy YES at 12¢ against the rumor.\n\nSTEP 3 — ENTRY\n- Buy YES when price < 20¢ and the extreme is sentiment-driven (not fundamental-driven)\n- Buy NO (equivalent: YES price > 80¢) when price is artificially elevated on sentiment\n- Enter with limit orders at mid or 1–2¢ better than ask\n- Position size: $20–$40 per trade\n\nSTEP 4 — EXIT RULES\n- Take profit when price reverts to within 10¢ of the pre-move level\n- Hard stop: if price moves 10¢ further against you after entry, exit and save a mistake memory\n- Do NOT hold through resolution if the position is still open at < 12 hours remaining — exit regardless of P&L\n\nSTEP 5 — MEMORY DISCIPLINE\nAfter each trade, use save_insight to record: (a) what caused the move you faded, (b) whether it was sentiment or fundamental, (c) outcome. Tag "resolution_fade". After 10 trades, use recall_lessons to review whether your sentiment vs fundamental judgment is accurate — update your rules if the data says otherwise.',
  true,
  'paper',
  1000
),

-- ─── S-003: Economic Consensus Anchor ────────────────────────────────────────
-- Trades KXFED, KXCPI, KXPAYROLLS, KXGDP toward analyst consensus when
-- Kalshi prices diverge from what the data implies.
-- Alpha source: retail prediction market participants often misprice
-- economic outcomes vs. trained economists and market-implied forecasts.
(
  'S-003',
  'Economic Consensus',
  'Trade Kalshi economic markets (Fed rate decisions, CPI, payrolls, GDP) toward analyst consensus when market prices diverge by more than 15¢. Economic prediction markets are frequently mispriced by retail participants relative to professional economist forecasts.',
  E'You are executing the Economic Consensus strategy. Your edge comes from Kalshi economic markets being priced by a mix of retail and professional participants — when they diverge from the professional consensus, the market tends to correct toward it.\n\nTARGET SERIES: KXFED, KXCPI, KXPAYROLLS, KXGDP, KXCHCUTS\n\nCORE THESIS\nFor economic releases, there is always a professional consensus forecast (Bloomberg survey median, Fed dot plot, CME FedWatch). Retail participants in prediction markets frequently overprice tail outcomes and underprice consensus outcomes. When Kalshi prices diverge from implied probability of consensus by > 15¢, trade toward consensus.\n\nSTEP 1 — IDENTIFY THE CONSENSUS\nFor each economic series, reason from your training data and any saved memories about what the current professional consensus is:\n- KXFED: Check what the Fed dot plot and CME FedWatch imply. "Will the Fed cut 25bps at [meeting]?" — if FedWatch shows 70% probability, Kalshi YES should be near 70¢.\n- KXCPI: The consensus CPI forecast from economists. If consensus is 3.1% and the market prices "CPI > 3.0%" YES at 40¢ when the actual consensus probability is ~65%, that is a buy.\n- KXPAYROLLS: ADP, initial claims, and economist consensus for NFP. If consensus is +180K jobs and "Payrolls > 150K" is trading at 45¢, that is mispriced.\n- KXGDP: Atlanta Fed GDPNow and economist consensus. Compare to Kalshi range markets.\n\nSTEP 2 — FIND THE MARKETS\nCall fetch_live_markets with category set to the target series (e.g. "KXFED"). Review all open markets. For each market, calculate: what probability does the professional consensus imply for this exact outcome?\n\nSTEP 3 — ENTRY CRITERIA\n- Divergence >= 15¢ between consensus-implied probability and Kalshi mid price → enter\n- Trade toward consensus (if consensus says 70% and market says 45%, buy YES)\n- Position size: $30–$50. Scale up to $75 if divergence > 25¢ and you have strong consensus confidence\n- Prefer limit orders 1–2¢ inside the current ask/bid\n\nSTEP 4 — EXIT RULES\n- Target: when market price reaches within 5¢ of consensus-implied probability\n- Stop: if market moves 15¢ further away from consensus after your entry (rare but signals something structural changed)\n- Always exit before the data release if you are uncertain — do not hold through the print unless your conviction is high\n\nSTEP 5 — AFTER THE RELEASE\nOnce the economic data is released, the market resolves or price updates sharply. Use reflect_on_trades immediately after each economic release cycle. Were your consensus estimates accurate? Save new insights about which data series you forecast best vs. worst. Use recall_lessons before each new trade — your own track record on KXFED vs KXCPI may differ significantly.\n\nIMPORTANT: Never trade economic markets within 30 minutes of the scheduled release if you are uncertain about the print. Liquidity dries up and spreads blow out.',
  true,
  'paper',
  1000
),

-- ─── S-004: Liquidity Provision ───────────────────────────────────────────────
-- Posts limit orders near the mid on liquid, range-bound markets.
-- Collects the bid-ask spread passively. Low directional risk.
-- Alpha source: Kalshi markets often have spreads 5–15¢ wide even on
-- liquid series. Posting at the mid earns the spread over time.
(
  'S-004',
  'Liquidity Provision',
  'Post limit orders at or near the mid on liquid, range-bound Kalshi markets to collect the bid-ask spread. Low directional exposure — earns the spread passively on markets unlikely to move sharply before fill.',
  E'You are executing the Liquidity Provision strategy. Your edge comes from collecting the bid-ask spread by posting limit orders near the mid price, rather than taking the spread as a price taker.\n\nCORE THESIS\nMany Kalshi markets have bid-ask spreads of 5–15¢ even at reasonable volume. A market at YES bid 38¢ / YES ask 48¢ (mid 43¢) is effectively paying 5¢ to anyone who posts a limit at 43¢ and gets filled on both sides over time. This strategy posts limit orders at the mid and collects that spread passively.\n\nSTEP 1 — FIND CANDIDATES\nCall fetch_signals. Filter for:\n- liquidity_score >= 0.5 (sufficient volume, not too thin)\n- spread >= 6¢ (enough spread to be worth capturing)\n- mid price between 30¢ and 70¢ (not near extremes where prices move sharply)\n- time_value_score between 0.3 and 0.7 (not expiring immediately, not months away)\n\nAlso check scan_surface for spread anomaly alerts — those are the highest-priority targets for this strategy.\n\nSTEP 2 — QUALIFY FOR RANGE-BOUND BEHAVIOR\nFor each candidate, fetch_live_markets on that series. You want markets where:\n- The price has been stable (< 10¢ movement) over recent sessions\n- No major catalysts are scheduled within 48 hours (no Fed meeting, no earnings, no data releases)\n- Open interest is reasonable (market has actual participants, not abandoned)\n\nSkip any market with a scheduled catalyst within 48 hours. Catalyst markets blow out spreads and gaps past your limit, causing adverse selection.\n\nSTEP 3 — ENTRY\nPost YES limit orders at mid price (or 1¢ below mid) for small size.\nPost NO limit orders at mid price (or 1¢ below mid) for the same small size.\nThis creates a "straddle" — you earn the spread if filled on both sides.\n- Position size per order: $10–$20. Never more than $25 on a single market.\n- Maximum open LP positions: 5 simultaneously.\n\nIMPORTANT: Execute these as two separate execute_trade calls — one buy YES, one buy NO.\n\nSTEP 4 — MANAGEMENT\nAfter each check_portfolio:\n- If one side filled but not the other within 4 hours: consider cancelling the unfilled side. The market moved against you — do not let directional exposure build.\n- If spread has compressed to < 3¢: cancel unfilled orders. The opportunity closed.\n- If price moves > 8¢ from your entry mid: cancel unfilled orders immediately.\n\nSTEP 5 — WHAT NOT TO DO\n- Do not use this strategy on markets < 3 days to resolution. Prices become directional, not range-bound.\n- Do not post on markets with volume_24h < 500 contracts. Too thin — you might be the only participant.\n- Do not hold both sides through a catalyst. Cancel before known events.\n\nAfter each week, use reflect_on_trades to calculate realized spread per filled order pair. Target > 3¢ average realized spread. If below that, the fills are too one-sided — tighten your target markets.',
  false,
  'paper',
  1000
)

ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  instructions = EXCLUDED.instructions,
  active = EXCLUDED.active,
  mode = EXCLUDED.mode,
  starting_balance = EXCLUDED.starting_balance,
  updated_at = now();
