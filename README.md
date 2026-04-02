# Omii TradeAgent

AI-powered trading agent for Kalshi event contracts.

## Features

- Live Kalshi market data with auto-refresh
- AI trading agent with tool calling (fetch markets, place orders, cancel orders, check portfolio)
- Limit and market order execution via Kalshi CLOB API
- Server-side risk management (position limits, daily loss caps, drawdown monitoring, auto-halt)
- Compliance logging with full audit trail and CSV export
- Real-time portfolio tracking from database
- Configurable trading strategies injected into agent context
- Paper trading mode for testing without real money

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS, shadcn/ui, Recharts
- **Backend**: Supabase (PostgreSQL + Edge Functions)
- **AI**: OpenRouter / OpenAI-compatible API with tool calling
- **Exchange**: Kalshi REST API v2 with HMAC-SHA256 authentication

## Setup

```sh
git clone <repo-url>
cd omii-tradeagent
npm install
npm run dev
```

### Environment Variables

Create a `.env` file:

```
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-anon-key
```

### Supabase Secrets

Set these in your Supabase project dashboard under Settings > Edge Functions:

```
OPENROUTER_API_KEY=sk-or-...        # or OPENAI_API_KEY
AI_BASE_URL=https://openrouter.ai/api  # optional, defaults to OpenRouter
KALSHI_API_KEY_ID=your-kalshi-key-id
KALSHI_API_PRIVATE_KEY=your-kalshi-private-key
KALSHI_ENVIRONMENT=demo              # or "production" for real trading
```

## Deployment

Build for production:

```sh
npm run build
```

Deploy the `dist/` folder to Vercel, Netlify, or any static hosting provider.

Deploy Supabase edge functions:

```sh
supabase functions deploy kalshi-proxy
supabase functions deploy execute-trade
supabase functions deploy trading-agent
```

## Architecture

```
src/
  lib/kalshiApi.ts          # Kalshi API client (market data, orders, positions)
  lib/strategiesContext.tsx  # Trading strategy state management
  components/trading/       # All UI panels (Markets, Agent, TradeLog, etc.)
  integrations/supabase/    # Supabase client and types

supabase/functions/
  kalshi-proxy/             # Authenticated proxy to Kalshi REST API
  execute-trade/            # Order execution with risk checks + compliance logging
  trading-agent/            # AI agent with tool calling for autonomous trading
```
