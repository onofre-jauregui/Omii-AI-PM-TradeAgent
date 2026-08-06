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
- **Current state (May 2026):** Agent is live and paper trading. Full multi-tenancy enforced in all edge functions (`user_id` scoped queries, RLS active). Encryption end-to-end for both Kalshi and AI provider keys. Onboarding flow complete. Stripe schema + webhook exist but no billing UI yet. Community knowledge-sharing layer not started.
- **Options agent** (`onofre-jauregui/omii-trade-agent`): shelved. Re-evaluate after Kalshi has a real track record.

## Polymarket code: do not extend

- `supabase/functions/polymarket-proxy/index.ts` and `src/lib/polymarketApi.ts`
  exist but are unreferenced from the rest of the codebase.
- Do **not** add new Polymarket features, fix Polymarket bugs, or write tests
  against Polymarket code paths.
- Pending user decision on whether to delete these files outright. Until then,
  treat them as dead code.

## Deploy & Credentials

- **Supabase project ref:** `uyfnezxmgwitpzsrnkst`
- **Supabase access token (project-scoped):** `$SUPABASE_ACCESS_TOKEN_KTA` — defined in `~/.omii_env`. Use this, never the global `$SUPABASE_ACCESS_TOKEN`, for all `supabase functions deploy` and management API calls in this project.
- **Deploy edge functions:** `source ~/.omii_env && SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA npx supabase functions deploy <function-name> --project-ref uyfnezxmgwitpzsrnkst`
- **Apply migrations:** `source ~/.omii_env && curl -s -X POST "https://api.supabase.com/v1/projects/uyfnezxmgwitpzsrnkst/database/query" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_KTA" -H "Content-Type: application/json" -d '{"query": "..."}'`
- **Never use** `npx supabase db push` — migration history is out of sync with remote.

## Dashboard verification — mandatory gate

**No change to this system is done until the UI dashboards have been opened in a real browser against the deployed target and confirmed to show correct, live values.** This applies to every change — frontend, edge function, migration, cron, and direct database writes — because all of them can silently break what the operator sees.

A green backend is not evidence the dashboard works. On 2026-08-04 a promotion passed lint, 307 unit tests, staging E2E, a production deploy, and a 30-minute canary while the live dashboard sat on a permanent loading spinner. The E2E suite only ever tested logged-out pages, so nothing in the pipeline had ever looked at the dashboard it was meant to protect.

**What must be checked, every time:**
1. **It paints.** The hero card shows real numbers within ~10s. A spinner that never resolves is a production outage, not a slow load.
2. **The numbers are true.** Rendered P&L matches the database — and for live mode, matches Kalshi's settlement ledger. A dashboard confidently displaying a wrong number is worse than a blank one.
3. **Nothing is silently empty.** Every chart either plots data or states why it can't. A bare axis with no series reads as broken.
4. **Both modes.** Paper and Live take different code paths; Live additionally awaits the Kalshi wallet ping. Checking one proves nothing about the other.
5. **The console and network are clean.** No uncaught errors, no 4xx/5xx on app requests, and no endpoint requested more than a couple of times per load — a request storm is how the spinner-hang manifests.

**How:** `npm run verify:dashboards` (Playwright, authenticated, asserts rendered values against the DB). It runs as a blocking CI gate on every push, and must be run by hand after any change CI can't observe — a direct SQL write, a manual edge-function deploy, a cron change.

**Failure modes this exists to catch** (all three have happened here): a permanent spinner from an unguarded `await` before the only `loading:false`; a chart rendering an empty box because its series list was empty; and correct-looking figures read from a column that was corrupt.

This is part of the VERIFIED gate in `~/.claude/STANDARDS.md` — "runs in its real environment" includes the screen.

## Branch strategy — hard rule

**feature → dev → main. No exceptions.**

- All feature/fix PRs use `--base dev`
- Only the `dev → main` promotion PR uses `--base main`
- Before creating any PR, state the base branch and confirm it's correct
- Before merging any PR, verify it's not bypassing dev
- Onofre must explicitly say "ship to production" / "promote dev to main" to trigger a dev→main PR

---

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
- Encryption end-to-end: Kalshi keys (save-kalshi-key) + AI provider keys (save-ai-key) both use AES-256-GCM; legacy plaintext fallback retained for zero-downtime
- Stripe schema: subscriptions table, stripe_events log, webhook handler scaffolded
- Auth page exists, Supabase auth wired
- Landing page: CSS variable theming, trust cards, flywheel section, Terms + Privacy pages, SEO meta/sitemap
- Onboarding flow: 4-step wizard (OnboardingPage.tsx) — Kalshi key entry wired to save-kalshi-key + kalshi-ping test, seeds S-002 + S-005 with $1k each on completion ✅
- S-001: KXINX/KXBTC/KXETH surface arb (bracket-sum violations)
- S-002 fixes: event-root dedup, 12h time-based auto-exit
- S-005 fixes: within-batch city dedup (seenCities), mid-price filter 10/90¢
- Agent memory → LLM gate: agent_memory active lessons injected into qualify prompt
- Dashboard redesign, performance page with category breakdown + P&L histogram, PWA support
- AgentPanel: chat-first layout, quick prompts (trimmed to 5), collapsible config
- `was_acted_on` fix: UPDATE after S-002 + S-005 fills (2026-05-25) ✅
- Prompt injection defense: `_shared/prompt-safety.ts`, XML-wrapped context, `parseQualifyResponse` validation (2026-05-25) ✅
- user_id wiring: all edge function queries scoped to user; migration `20260524_agent_memory_user_id.sql` applied (2026-05-25) ✅
- auto-settle: handles all Kalshi terminal statuses — active/closed/settled/finalized/voided/cancelled (2026-05-25) ✅
- Dashboard: "Last settled" chip uses `settled_at`; win streak badge (≥2 days) displayed under AgentStatusBadge; gap day > 1 breaks streak in both frontend + backend (2026-05-25) ✅
- Win streak: computed in auto-trade `computeWinStreak()`, passed as inert observability context into S-002 + S-005 qualify prompts — no decision rules tied to it (2026-05-25) ✅
- surface-scanner cache age bug fixed: `Math.min` → `Math.max` so newest cache row is found (2026-05-25) ✅
- Strategy leaderboard + chart: user ID suffix stripped from labels (2026-05-25) ✅
- Subscription tier enforcement: `checkEntitlement()` (`_shared/billing.ts`) — real per-tier `maxTradesPerDay`/`maxOpenPositions`/`maxPositionUsd` limits (not display-only), wired into `auto-trade`, `execute-trade`, and `switch-trading-mode`. **Deployed to production** via the `dev → main` promotion PRs #176/#179 (2026-08-03, 89 commits) — confirmed by diffing deployed edge-function source against `dev`: zero drift on all 32 functions as of the 105th health-check run (2026-08-04) ✅

### In progress / partially done
- Stripe: schema and webhook handler exist, no billing UI yet

### Not started
- Community knowledge-sharing layer (`is_platform_shared`, platform memory promotion pipeline, opt-out enforcement)
- Public performance page (the track record artifact — code exists but not live-linked)
- User feedback mechanism (thumbs up/down on agent decisions)

### Priority order
1. ~~`suspended_until` migration~~ — already live in DB (2026-05-23)
2. ~~Wire `user_id` into all edge function queries~~ — done (2026-05-25)
3. ~~Finish encryption key management end-to-end~~ — done (2026-05-25)
4. ~~Onboarding flow end-to-end~~ — done, fully wired (2026-05-25)
5. Billing UI (enforcement itself is done and live in production — see above)
6. User feedback mechanism
7. Community knowledge-sharing layer (the moat — highest strategic value)
8. Public performance page (track record artifact for uncle capital unlock)
