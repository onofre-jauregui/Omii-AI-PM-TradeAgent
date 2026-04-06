# Omii AI-PM TradeAgent

AI-powered trading platform for Kalshi prediction markets. Features an autonomous agent that learns from its own trades, auto-disables losing strategies, and adjusts confidence in its own insights based on real P&L.

## What It Does

- **AI trading agent** that fetches live markets, places orders, and manages positions on Kalshi
- **Persistent learning** -- agent saves lessons from trades and uses them to make better decisions over time
- **Automated feedback loop** -- hourly cron job adjusts memory confidence based on actual P&L and disables underperforming strategies
- **Paper & live trading** -- test strategies risk-free before switching to real money
- **Server-side risk management** -- position limits, daily loss caps, drawdown halt, auto stop-loss

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, Radix UI
- **Backend**: Supabase (PostgreSQL + Edge Functions + Realtime + pg_cron)
- **AI**: OpenRouter, OpenAI, Anthropic, Google AI (multi-provider)
- **Exchange**: Kalshi REST API v2 with HMAC-SHA256 authentication
- **Hosting**: Vercel (frontend), Supabase (backend)

## Quick Start

```bash
git clone https://github.com/onofre-jauregui/Omii-AI-PM-TradeAgent.git
cd Omii-AI-PM-TradeAgent
npm install
cp .env.example .env.local  # add your Supabase URL + anon key
npm run dev
```

## Documentation

Full documentation is maintained in the project's Obsidian vault under `OMII AI Agency/Projects/TradeAgent/`:

- **Product Overview** -- features, value proposition, how it works
- **Technical Architecture** -- system design, data flow, edge functions
- **Database Schema** -- all tables, relationships, RLS policies
- **Agent Memory System** -- learning loop, confidence scoring, auto-reflect
- **Risk Management** -- server-side controls, compliance logging
- **Setup & Deployment** -- step-by-step installation and configuration
- **API Reference** -- edge function endpoints, parameters, responses

## License

Proprietary -- OMII AI Agency
