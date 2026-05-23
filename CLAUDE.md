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

## Product vision

The product is a **community-powered AI trading SaaS** on Kalshi prediction markets.

### How it works
1. Users create an account and connect their Kalshi API or MCP keys
2. The agent trades on their behalf using the platform's strategy engine
3. Every trade generates a lesson — wins and losses are reflected into `agent_memory`
4. By default, user lessons are **contributed to the platform's shared memory pool**, making the model smarter for everyone
5. Users can **opt out** of knowledge sharing — but opted-out users stop receiving platform-wide memory updates and trade in isolation
6. This creates a **community growth flywheel**: more users → more trades → better shared memory → better returns for contributors → more users

This is the moat. Not the code. The compounding collective intelligence that a solo operator or closed-source competitor cannot replicate.

### Knowledge sharing mechanics (to build)
- `agent_memory` rows need `is_platform_shared` boolean and `user_id` enforcement
- Platform-level memories owned by `user_id = NULL` (global), injected for all opted-in users
- High-confidence user lessons (confidence > 0.7, confirmed 3+ times) become candidates for platform promotion
- Promotion requires a validation step before a user insight becomes global signal
- Opted-out users: no platform memory injected, no lesson contributions accepted

## Project context

- **Market:** Kalshi prediction markets only. Locked-in scope (April 2026):
  (1) Polymarket ToS prohibit US persons — user is in California;
  (2) Polymarket is 30%+ bot-saturated;
  (3) Kalshi posted $13.07B notional in March 2026 (up 25% MoM), $23.8B in 2025 (1,100% YoY).
- **Stack:** React/Vite/TS frontend, Supabase (Postgres + edge functions + pg_cron), multi-provider LLM (OpenRouter, OpenAI, Anthropic, Google), Kalshi REST v2 with HMAC-SHA256 auth.
- **Current state (April 2026):** Agent has paper traded. Core pipeline built and running. Multi-tenancy schema exists (`user_id` columns, RLS, encryption migration) but edge functions do not yet enforce `user_id` — single-user effectively. Stripe/subscriptions schema written, webhook scaffolded, not wired to billing UI. Community knowledge-sharing layer does not exist yet.
- **Options agent** (`onofre-jauregui/omii-trade-agent`): shelved. Re-evaluate after Kalshi has a real track record.

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

## Build status & priorities

### Done (verified in code)
- Trading pipeline: signal generation, surface scanner, basket execution, auto-settle
- Memory system: agent_memory, auto-reflect hourly loop, compact-memory, confidence feedback
- Strategy health monitor: consecutive-loss warnings (3/10/15), suspension + auto-resume
- Multi-tenancy schema: user_id columns, RLS policies written
- Encryption migration: api_keys ciphertext column, encryption helper module
- Stripe schema: subscriptions table, stripe_events log, webhook handler scaffolded
- Auth page exists, Supabase auth wired
- Landing page: CSS variable theming, trust cards, flywheel section, Terms + Privacy pages, SEO meta/sitemap
- Onboarding flow: multi-step wizard exists (OnboardingPage.tsx), seeds S-002 + S-005 with $1k each ($2k total paper portfolio) on completion
- S-001: KXINX/KXBTC/KXETH surface arb (bracket-sum violations)
- S-002 fixes (2026-05-15): event-root dedup (no duplicate thresholds per event), 12h time-based auto-exit
- S-005 fixes (2026-05-15): within-batch city dedup (seenCities), mid-price filter 5/95¢ → 10/90¢
- Agent memory → LLM gate: agent_memory active lessons now injected into qualify prompt alongside trade_lessons
- Dashboard redesign, performance page with category breakdown + P&L histogram, PWA support
- AgentPanel: chat-first layout, quick prompts (trimmed to 5), collapsible config

### In progress / partially done
- Onboarding: flow exists but API key entry step not wired end-to-end to encryption
- Edge functions: `user_id` column exists in schema but queries don't filter by it yet — single-user in practice
- Encryption: migration written, `encrypted_secret` plaintext column still present, key management not wired end-to-end
- Stripe: schema and webhook handler exist, no billing UI, no subscription enforcement in edge functions
- `suspended_until` column on strategies: ✅ live in DB (verified 2026-05-23)

### Not started
- Community knowledge-sharing layer (`is_platform_shared`, platform memory promotion pipeline, opt-out enforcement)
- Public performance page (the track record artifact — code exists but not live-linked)
- User feedback mechanism (thumbs up/down on agent decisions)

### Priority order
1. ~~`suspended_until` migration~~ — already live in DB (2026-05-23)
2. Wire `user_id` into all edge function queries (unblocks true multi-tenancy)
3. Finish encryption key management end-to-end (security blocker)
4. Billing UI + subscription enforcement
5. Community knowledge-sharing layer (the moat — highest strategic value)
6. User feedback mechanism
7. Public performance page (track record artifact for uncle capital unlock)
