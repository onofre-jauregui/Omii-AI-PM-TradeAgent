# Omii AI-PM TradeAgent — Session Rules

This project is building toward a specific financial goal. The user wants
reality, not encouragement. All global truth rules in `~/.claude/CLAUDE.md`
apply here as well.

## Stated goal

- **Target: $10M personal net worth in 5 years** (recalibrated from $50M
  during this session). $10M is roughly the top 1% household net worth
  threshold in the US per Federal Reserve SCF data.
  `[verified earlier in conversation]`
- Plan optimizes for the highest-probability path to $10M while preserving
  optionality for higher outcomes. Bootstrapped paths are now on the table
  (no venture exit required at this target). The fund-side path opens up at
  smaller AUM ($25M–$50M) than it did at the $50M target.
- Do not repeat the $50M framing. Do not soften the $10M target with
  motivational language about how easy it is. It is not easy. It is rare
  but achievable for someone with technical ability, focus, family-capital
  access, and good execution. The plan is built to maximize probability,
  not predict the median.

## Project context

- **Product:** AI trading agent for **Kalshi prediction markets only**.
  Kalshi-only is an explicit, locked-in scope decision (April 2026) based on
  three verified facts:
  (1) Polymarket's Terms of Service prohibit US persons from trading via UI,
  API, or AI agents, and the user is in California;
  (2) Polymarket is significantly more bot-saturated (30%+ of wallets use AI
  agents, 14 of top 20 most profitable wallets are bots) — verified via
  Finance Magnates and LayerHub data, April 2026;
  (3) Kalshi posted $13.07B notional volume in March 2026 (up 25% MoM) and
  $23.8B in 2025 (1,100% YoY growth) — verified via Cryptopolitan and DeFi
  Rate, April 2026. The TAM is no longer the constraint.
- A second agent for options markets exists in a separate repo
  (`onofre-jauregui/omii-trade-agent`) but is out of scope for my GitHub tools
  and out of scope for the current product. It is shelved, not killed —
  re-evaluate as a capacity-expansion vehicle once Kalshi has a real track
  record.
- **Stack:** React/Vite/TS frontend, Supabase (Postgres + edge functions +
  pg_cron) backend, multi-provider LLM (OpenRouter, OpenAI, Anthropic, Google),
  Kalshi REST v2 with HMAC-SHA256 auth.
- **Current state (as of this session):** Code is built. Agent has NOT been
  tested — no backtest, no paper trading, no live trading. Multi-tenancy
  migration exists but the edge functions ignore `user_id` and `encrypted_secret`
  is plaintext — both are SaaS blockers. $100 MRR comes from an unrelated
  client website, not from this product.
- **Development branch:** `claude/financial-freedom-planning-xucYQ`.

## Polymarket code: do not extend

- `supabase/functions/polymarket-proxy/index.ts` and `src/lib/polymarketApi.ts`
  exist but are unreferenced from the rest of the codebase.
- Do **not** add new Polymarket features, fix Polymarket bugs, or write tests
  against Polymarket code paths.
- Pending user decision on whether to delete these files outright. Until then,
  treat them as dead code.

## Rules specific to this project

### On trading performance claims

- **Never state or imply that the agent is profitable** unless you have
  directly read a P&L number from a file, database, or tool output in this
  session. As of the last checkpoint, the agent has never been tested, so
  any claim about its performance is unsupported.
- When discussing the agent's potential, label as `[opinion]`.
- When discussing trading outcomes generally, cite academic literature or
  verified market data, or label as `[opinion]` / `[rough estimate]`.

### On the $50M / 5-year goal

- This is the user's stated goal. It is extraordinarily ambitious.
- Do not repeat motivational framings about how achievable it is.
- Do not invent base rates for founder outcomes, fund returns, or exit
  probabilities. If a decision depends on a base rate, use WebSearch or
  label the estimate as unverified.
- Plans should maximize the probability of the best feasible outcome, not
  assume the best outcome is the median.

### On family capital (uncle, ~$50k, gated on "positive returns")

- Treat this as the most sensitive money in the plan. The unlock is a real
  paper-trading track record, not a pitch.
- Before any uncle conversation, a concrete pre-agreed performance bar
  should exist in writing so the goalposts don't move.
- Do not recommend taking family capital into a trading strategy that has
  not cleared a defined paper-trading bar.

### On what to build

- Code is a commodity in 2026. The moats are: track record, distribution,
  trust, regulatory posture, real edge, proprietary feedback loops, and
  capital access. Prioritize human time on those layers; vibe-code the
  commodity layer fast.
- Focus is the scarcest founder resource. Default to one product, one
  market, one story at a time.
- Current strategic lead: prediction markets agent for SaaS + track record.
  Options agent stays on the shelf for capacity expansion later. This is
  a recommendation, not a commitment; re-evaluate if new information
  changes the picture.

### On execution

- Before writing code, read the file. Before claiming a file does X, read it.
- Don't add features beyond what was asked.
- Don't add speculative abstractions.
- Don't claim something was built unless you can point at the file.
- Separate "planned" from "scaffolded" from "implemented" from "tested."

## What I should be doing in this repo

The prioritized work, in order, is captured in conversation and will live
in a tracked plan file once we start shipping. The blocker tier for Path 2
(SaaS) is:

1. Code-correctness test scaffolding
2. Paper trading verification and activation (requires user-provided creds
   stored as Supabase secrets — I never see them in plaintext)
3. Public live-updating performance page (the track record artifact)
4. Stripe billing + subscription tiers
5. Secure per-user Kalshi key storage (encrypted at rest)
6. Onboarding flow
7. Production auth hardening
8. Landing page with embedded proof page
9. Legal disclaimers (drafts only; lawyer reviews before launch)

None of this is done yet. Do not claim otherwise.
