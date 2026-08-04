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

## Repository Layout

Every top-level surface, and what changes where:

| Path | What lives there |
|------|------------------|
| `src/` | React frontend — `pages/` (routes), `components/` (UI, incl. `components/trading/`), `lib/` (Kalshi/Supabase clients, query helpers, strategy context), `hooks/`, `integrations/supabase/` (generated types) |
| `supabase/functions/` | 33 Deno edge functions — the entire backend. Trading loop (`auto-trade`, `execute-trade`, `execute-basket`), signals (`signal-generator`, `surface-scanner`, `weather-signal`), settlement (`auto-settle`, `settle-signals`, `reconcile-orders`), learning (`auto-reflect`, `compact-memory`), ops (`health-check`, `kalshi-proxy`). Shared code in `_shared/`, unit tests in `tests/` |
| `supabase/migrations/` | 69 SQL migrations, applied by CI (never `supabase db push` — see `CLAUDE.md`) |
| `tests/e2e/` | Playwright end-to-end specs run against the deployed staging site |
| `docs/` | All project documentation — start at [`docs/INDEX.md`](docs/INDEX.md) |
| `public/` | Static assets and PWA icons |

## Documentation

[`docs/INDEX.md`](docs/INDEX.md) is the currency dashboard — doc, version, last updated, status. Check it before trusting any doc is current.

Frequently needed:

- [`DESIGN-REPORT.md`](DESIGN-REPORT.md) — behavioral spec and feature inventory
- [`docs/system-report.md`](docs/system-report.md) — architecture, data flow, edge functions
- [`DECISIONS.md`](DECISIONS.md) — append-only log of architectural decisions and why
- [`docs/REALMONEY-RUNBOOK.md`](docs/REALMONEY-RUNBOOK.md) — live-trading procedures
- [`docs/runbooks/`](docs/runbooks/) — operational recovery procedures
- [`docs/observability.md`](docs/observability.md) — tracing, compliance logging, alerting
- [`CLAUDE.md`](CLAUDE.md) — deploy commands, credentials, branch strategy

## Testing

```bash
npm test              # unit tests (Vitest)
npm run test:e2e      # Playwright E2E
npm run test:integration  # hits deployed functions as the E2E account, paper mode only
npm run lint
```

## License

Proprietary -- OMII AI Agency
