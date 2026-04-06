# Omii AI-PM TradeAgent

AI-powered trading platform for Kalshi prediction markets. Features an autonomous agent that learns from its own trades, auto-disables losing strategies, and adjusts confidence in its own insights based on real P&L.

## Architecture

```
Frontend (React + Vite)          Supabase Edge Functions         External APIs
  |                                |                               |
  |-- AgentPanel ---- POST -----> trading-agent ---- fetch -----> Kalshi API
  |-- MarketsPanel -- GET ------> kalshi-proxy ----- fetch -----> Kalshi API
  |-- SettingsPanel                execute-trade                   OpenRouter
  |-- DemoPanel                    list-ai-models                  OpenAI
  |-- TradeLog                     polymarket-proxy                Anthropic
  |-- ...                          auto-reflect (cron)             Google AI
  |                                |
  |------------ Supabase Client ---+--- PostgreSQL (trades, strategies, agent_memory, ...)
                                   +--- Realtime (live updates)
                                   +--- pg_cron (hourly auto-reflect)
```

## Quick Start

### Prerequisites
- Node.js 18+
- A [Supabase](https://supabase.com) project
- At least one AI provider key (OpenRouter recommended)

### 1. Clone & Install

```bash
git clone https://github.com/onofre-jauregui/Omii-AI-PM-TradeAgent.git
cd Omii-AI-PM-TradeAgent
npm install
```

### 2. Environment Variables

Create `.env.local`:

```env
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<your-anon-key>
```

### 3. Apply Database Migrations

Migrations are in `supabase/migrations/` and should be applied in order via the Supabase Dashboard (SQL Editor) or CLI:

```bash
supabase db push
```

### 4. Deploy Edge Functions

```bash
supabase functions deploy trading-agent --no-verify-jwt
supabase functions deploy execute-trade
supabase functions deploy kalshi-proxy
supabase functions deploy list-ai-models --no-verify-jwt
supabase functions deploy polymarket-proxy --no-verify-jwt
supabase functions deploy auto-reflect --no-verify-jwt
```

### 5. Set Edge Function Secrets

In Supabase Dashboard > Edge Function Secrets (or via CLI):

```bash
supabase secrets set ALLOWED_ORIGIN="https://your-app.vercel.app"
```

For the hourly auto-reflect cron job, add your `service_role` key to **Database > Vault > Secrets** with the name `service_role_key`.

### 6. Run Locally

```bash
npm run dev
```

### 7. Deploy Frontend

Push to GitHub with the Vercel integration, or:

```bash
vercel deploy --prod
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Vercel environment variables.

---

## Features

### Trading
- **Paper & Live modes** -- test strategies risk-free, then switch to real money on Kalshi
- **Multi-strategy tracking** -- create strategies with custom instructions, track P&L per strategy
- **Risk management** -- position limits, daily loss caps, drawdown halt, auto stop-loss (enforced server-side)
- **Liquidity checks** -- verifies order book depth before placing live orders
- **Compliance logging** -- every trade action, risk check, and error is logged with severity levels

### AI Agent
- **Multi-provider** -- supports OpenRouter (200+ models), OpenAI, Anthropic, Google AI
- **Tool use** -- agent can fetch markets, place trades, check portfolio, cancel orders
- **Streaming chat** -- real-time SSE responses with markdown rendering
- **Strategy injection** -- active strategy instructions are loaded into the agent's system prompt

### Autonomous Learning
- **Persistent memory** -- agent saves lessons, patterns, mistakes, successes to database
- **Confidence scoring** -- memories start at 50% confidence; confirmed insights rise, contradicted ones fade
- **Automatic P&L feedback** -- hourly cron updates memory confidence based on actual trade outcomes
- **Strategy auto-disable** -- strategies with ROI < -10% or (negative ROI + <30% win rate) are automatically turned off
- **Trade reflections** -- agent records expected outcomes before trades, compares to reality after

---

## App Tabs

| Tab | Description |
|-----|-------------|
| **Dashboard** | Portfolio value, P&L chart, strategy performance leaderboard |
| **Markets** | Browse Kalshi markets with live prices, search, filter by category/close date |
| **Strategies** | Create, edit, toggle strategies. Each has name, instructions, mode, starting balance |
| **Demo** | Paper trading sandbox with configurable balance and embedded agent (paper mode only) |
| **Live Agent** | Full AI agent chat with model selection, temperature, system prompt, paper/live toggle |
| **Trade Log** | History of all trades with status, P&L, strategy, order details |
| **Compliance** | Audit log of all events (orders, risk checks, errors) with severity filtering |
| **Settings** | API keys (AI providers + Kalshi), risk limits, notification preferences |
| **Profile** | Trader stats: total trades, win rate, P&L, Sharpe ratio |

---

## Database Schema

### Core Tables

| Table | Purpose |
|-------|---------|
| `trades` | All paper and live trades with status, P&L, strategy, order details |
| `strategies` | Strategy definitions with instructions, mode, starting balance |
| `risk_settings` | Risk limits (max loss, drawdown, position size, open positions) |
| `risk_state` | Daily risk tracking (P&L, trade count, position count, halt status) |
| `api_keys` | Encrypted storage for AI provider and Kalshi credentials |
| `compliance_log` | Audit trail of all trading events with severity levels |

### Learning Tables

| Table | Purpose |
|-------|---------|
| `agent_memory` | Persistent lessons with confidence scoring, tags, strategy links |
| `trade_reflections` | Expected vs actual outcomes for post-trade analysis |

### Supporting

| Table | Purpose |
|-------|---------|
| `strategy_snapshots` | Time-series performance data per strategy |
| `open_positions` (view) | Computed active positions from filled buy trades |

All tables have Row-Level Security (RLS) policies supporting multi-tenancy via `user_id`.

---

## Edge Functions

| Function | Auth | Purpose |
|----------|------|---------|
| `trading-agent` | No JWT (handles auth internally) | AI agent orchestration -- tool use loop with 8 tools, multi-provider routing |
| `execute-trade` | JWT required | Trade execution with risk checks, liquidity verification, compliance logging |
| `kalshi-proxy` | JWT required | Proxies Kalshi API requests, handles HMAC auth for private endpoints |
| `list-ai-models` | No JWT | Lists available AI models from configured providers |
| `polymarket-proxy` | No JWT | Passthrough proxy for Polymarket public API |
| `auto-reflect` | No JWT (called by pg_cron) | Hourly automated learning -- P&L confidence updates, strategy auto-disable |

### Shared Code

`supabase/functions/_shared/kalshi-auth.ts` -- HMAC-SHA256 signing, auth header generation, and credential loading shared between `execute-trade` and `kalshi-proxy`.

---

## Agent Memory System

The agent has a persistent learning system that survives across sessions.

### Memory Types

| Type | Purpose |
|------|---------|
| `lesson` | General trading wisdom |
| `pattern` | Recurring market behavior |
| `mistake` | What went wrong and why |
| `success` | What worked and should be repeated |
| `market_note` | Observations about specific markets |
| `strategy_insight` | Learnings tied to a specific strategy |

### Confidence Lifecycle

```
New insight saved (default 50% confidence)
        |
  [Trade linked to insight resolves]
        |
   Profitable? ----YES----> +5% confidence (auto) / +10% (manual)
        |
       NO
        |
   Unprofitable? --> -10% confidence (auto) / -15% (manual)
        |
   Confidence < 15%? --> Auto-deactivated (hidden from agent)
        |
   Confidence > 95%? --> Capped (never fully certain)
```

### What Runs Automatically (Hourly)

1. **P&L confidence updates** -- memories linked to trades get confidence adjusted based on outcomes
2. **Strategy auto-disable** -- checks all strategies with 5+ trades, disables underperformers
3. **Unreflected trade counting** -- feeds into agent prompt to encourage reflection

### What the Agent Does On-Demand

1. `recall_lessons` -- searches memory before trading decisions
2. `reflect_on_trades` -- analyzes recent outcomes, identifies patterns
3. `save_insight` -- stores new lessons from analysis
4. `update_memory` -- manually confirm/contradict/deactivate memories

---

## Risk Management

Risk limits are enforced **server-side** in the `execute-trade` function. The agent cannot bypass them.

| Check | Default | Behavior |
|-------|---------|----------|
| Max position size | $500 | Order rejected if amount exceeds |
| Max daily loss | $500 | Trading halted for the day |
| Max drawdown | 20% | Trading halted |
| Max open positions | 10 | New buys rejected until positions close |
| Auto stop-loss | 15% | Configurable per-trade |

Paper mode bypasses risk checks. All checks are logged to `compliance_log`.

---

## Security

- **CORS** -- all edge functions read `ALLOWED_ORIGIN` env var (set to your Vercel domain)
- **API keys** -- stored in Supabase `api_keys` table
- **RLS** -- row-level security on all tables, scoped by `user_id`
- **Input validation** -- edge functions validate required fields, types, and ranges
- **Auth** -- Supabase Auth with email/password (currently disabled for development)
- **HMAC signing** -- Kalshi API requests signed with Web Crypto API

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite |
| UI | Radix UI, Tailwind CSS, Lucide Icons, Recharts |
| State | React Context (strategies), React Query |
| Backend | Supabase Edge Functions (Deno) |
| Database | PostgreSQL via Supabase |
| Realtime | Supabase Realtime (postgres_changes) |
| Scheduling | pg_cron + pg_net |
| AI Providers | OpenRouter, OpenAI, Anthropic, Google AI |
| Trading API | Kalshi REST API v2 |
| Hosting | Vercel (frontend), Supabase (backend) |

---

## Project Structure

```
src/
  pages/
    Index.tsx              # Main SPA with tab routing
    AuthPage.tsx           # Login/signup (disabled)
  components/
    trading/
      Sidebar.tsx          # Navigation sidebar
      AgentPanel.tsx       # AI agent chat interface
      MarketsPanel.tsx     # Kalshi market browser
      StrategiesPanel.tsx  # Strategy CRUD
      DemoPanel.tsx        # Paper trading sandbox
      TradeLog.tsx         # Trade history table
      CompliancePanel.tsx  # Audit log viewer
      SettingsPanel.tsx    # API keys & risk settings
      ProfilePanel.tsx     # Trader stats
      PortfolioOverview.tsx # Stats cards + positions
      PortfolioChart.tsx   # Portfolio balance chart
      StrategyPerformance.tsx # Strategy leaderboard
    ui/                    # 60+ shadcn/ui primitives
  lib/
    kalshiApi.ts           # Kalshi client (via proxy)
    polymarketApi.ts       # Polymarket client (via proxy)
    strategiesContext.tsx   # Strategy state management
    mockData.ts            # Fallback market data
    utils.ts               # Tailwind class merging

supabase/
  functions/
    trading-agent/         # AI agent orchestration (1100 LOC)
    execute-trade/         # Trade execution + risk checks
    kalshi-proxy/          # Kalshi API proxy
    list-ai-models/        # AI model listing
    polymarket-proxy/      # Polymarket API proxy
    auto-reflect/          # Automated learning loop
    _shared/
      kalshi-auth.ts       # Shared HMAC/auth utilities
  migrations/
    20260315..._initial.sql
    20260402..._kalshi_upgrade.sql
    20260402..._strategies_table.sql
    20260403..._multi_tenancy.sql
    20260404_agent_memory.sql
    20260406_auto_reflect_cron.sql
```
