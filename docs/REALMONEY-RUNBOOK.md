# Real-money trading — apply & go-live runbook

The complete resolution for safe, correct real-money trading on Kalshi. All code,
migrations, and tests are written and verified locally (164 tests pass, `vite build`
clean). This runbook is the ordered set of **prod-touching steps** to apply them.

Branch: `fix/live-tab-ui-and-safety`. Supabase project ref: `uyfnezxmgwitpzsrnkst`.

> Deploys and the first real trade are Hard Stops — nothing below runs automatically.

---

## What changed

**Foundation (UI + immediate safety):** wallet-balance flicker fixed; live-tab
mode-leaks fixed; avatar dropdown; "Run Live" removed from paper cards; client kill
switch repaired; live trade fail-closes with no risk limits.

**W1 — schema integrity:** `trades.status` allows `settled`; `risk_settings.max_daily_trades`
added; `risk_state` gets a real `UNIQUE(user_id, date)`; every user seeded with default
risk limits (trigger + backfill).

**W2 — risk enforcement:** `allocated_capital` now enforced on *every* live path (single
order, agent leg, basket) via `evaluateCapitalCap`; server-side auto-halt persistence fixed
(`setRiskHalt`).

**W3 — reconciliation + live settlement:** new `reconcile-orders` function advances resting
live orders (fill/partial/cancel) from Kalshi every 5 min; the settlement view now includes
live trades; the expiration sweep no longer zeroes real-money fills.

**W4 — live console:** positions show order status + a cancel action for resting orders;
live banner copy corrected. (HITL approve/reject is already surfaced in live mode.)

**W5 — tests:** `evaluateCapitalCap` + `decideReconcile`/`contractCount`/`pickAvgPrice`
covered; `risk.test.ts` `baseSettings` completed.

---

## Apply order (do NOT reorder)

### 1. Apply the foundation migration
```bash
source ~/.omii_env
curl -s -X POST "https://api.supabase.com/v1/projects/uyfnezxmgwitpzsrnkst/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_KTA" -H "Content-Type: application/json" \
  --data-binary "$(jq -Rs '{query: .}' supabase/migrations/20260719_realmoney_foundation.sql)"
```
Review the one `DELETE` (a commented safety de-dup on `risk_state`) before running.

### 2. Deploy the edge functions  ⛔ HARD STOP (production)
```bash
source ~/.omii_env
for fn in execute-trade execute-basket auto-settle reconcile-orders; do
  SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA \
    npx supabase functions deploy "$fn" --project-ref uyfnezxmgwitpzsrnkst
done
```

### 3. Apply the reconciliation migration (after reconcile-orders is deployed)
```bash
curl -s -X POST "https://api.supabase.com/v1/projects/uyfnezxmgwitpzsrnkst/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_KTA" -H "Content-Type: application/json" \
  --data-binary "$(jq -Rs '{query: .}' supabase/migrations/20260719_realmoney_reconciliation.sql)"
```

### 4. Regenerate types + rebuild
```bash
SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA npm run db:types   # clears the stale-type tsc noise
npm run build
```

### 5. Deploy the frontend  ⛔ HARD STOP (production)
`kalshitradeagent.live` (dev branch) first → verify on a real login → then merge to
`main` + promote on Vercel. Confirm the production domain serves the new build (`vercel ls`,
alias if needed). Hard-refresh once — the PWA service worker is `autoUpdate`, so it self-heals.

> **`.live` is not a staging environment.** Its bundle points at the production Supabase
> project (`uyfnezxmgwitpzsrnkst`), the same one `.com` uses. It is a second frontend over
> the *same* backend, so a "verify on a real login" here reads and writes production data.
> It catches frontend regressions before `.com` moves; it proves nothing about a migration
> or an edge function. TradeAgent has no staging backend — see DECISIONS.md (2026-08-06).

---

## Verify (before any real money)

Run these read-only checks after steps 1–5:

- **Schema:** `trades_status_check` includes `settled`; `risk_settings` has `max_daily_trades`;
  `risk_state` has `risk_state_user_date_key UNIQUE (user_id, date)`; every `auth.users` row has
  a `risk_settings` row.
- **Kill switch:** toggle "Pause All Trading" in Risk Controls → `risk_state` row shows
  `is_trading_halted=true` with your `user_id`; a live order then returns `trading_halted` before
  any Kalshi call.
- **Aggregate cap:** with `allocated_capital=100`, a live order that would push open exposure over
  $100 returns `capital_cap` (writes a `status:failed` trade + `risk_check_failed` log, no Kalshi call).
- **Fail-closed:** a live order for a user with no `risk_settings` row is blocked (`no_risk_settings`).
- **Cron:** `SELECT * FROM cron.job WHERE jobname='reconcile-orders-cron';` is active; after a few
  minutes `agent_cron_health` shows it running.

---

## First real trade  ⛔ HARD STOP (enable live, first order + approval)

Pre-flight (confirm all true):
1. Supabase secrets set: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`,
   `API_KEY_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (else live fails-closed 503).
2. Telegram `getWebhookInfo` points at the deployed `/telegram-webhook?secret=…`.
3. Your `subscriptions` row is a paid tier + active/trialing (live entitlement).
4. `api_keys` has `provider='kalshi_live'`; the live wallet renders (~$2,600).
5. `risk_settings`: `max_position_size=100`, `max_open_positions=1`, `allocated_capital=100`.
6. No stale halt for today.

Then: flip `trading_mode=live` → in the Agent chat place a single **marketable-limit** order on a
deep, liquid market, amount $100 → approve in-app (HITL card) or Telegram. Toggle the kill switch on
afterward.

**Verify go-live:** the trade row goes `filled` with a real `filled_price` and `order_id`; if it
rests, `reconcile-orders` advances it within ~5 min; the wallet drops ~$100; settlement computes real
PnL at market resolution; the expiration sweep never touches it.

---

## Known follow-ups (out of scope, non-blocking)

- Live **sell-side** settlement: the settlement view is `action='buy'` only (matches paper);
  `computePnl` doesn't yet handle sells.
- Dashboard-level kill switch (currently in the Risk tab; HITL already gates every trade).
- Partial-fill price precision uses the order's average; per-fill weighting via `/portfolio/fills`
  is a refinement.
