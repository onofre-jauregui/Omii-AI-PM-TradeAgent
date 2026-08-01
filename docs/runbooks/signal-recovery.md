# Runbook: recover the 8,854 `unsettleable_404` signals

**Context:** settle-signals 404'd on 100% of lookups for months (doubled URL
path, fixed in PR #169) and stamped every signal `unsettleable_404` with
`settled_at` set — so the URL fix alone recovers nothing: the poisoned rows are
excluded from every future batch by the `settled_at IS NULL` gate. Some tickers
HAVE genuinely aged out of Kalshi's archive; a blanket reset would re-poison
those. Production-only operation (staging holds no signal data) — **requires
Onofre's explicit go.**

## 1. Probe (read-only, run first)

Sample 20 poisoned tickers against the corrected path; expect a mix of 200s
(recoverable) and 404s (genuinely archived):

```sql
SELECT ticker FROM signals WHERE settlement_status = 'unsettleable_404'
ORDER BY created_at DESC LIMIT 20;
```

```bash
for t in <tickers>; do
  curl -s -o /dev/null -w "$t %{http_code}\n" \
    "https://api.elections.kalshi.com/trade-api/v2/markets/$t"; done
```

## 2. Reset in dated tranches (newest first)

Newest signals are most likely still in Kalshi's archive. One tranche per day;
settle-signals' RUN_BUDGET_MS (PR #169) drains each within its 15-min cron
without starving fresh signals.

```sql
-- Tranche N: one week of poisoned rows, newest week first
UPDATE signals
SET settled_at = NULL, settlement_status = NULL
WHERE settlement_status = 'unsettleable_404'
  AND created_at >= now() - interval '7 days' * N
  AND created_at <  now() - interval '7 days' * (N - 1);
```

## 3. Verify per tranche

```sql
SELECT count(*) FILTER (WHERE shadow_pnl IS NOT NULL) AS recovered,
       count(*) FILTER (WHERE settlement_status = 'unsettleable_404') AS still_dead,
       count(*) FILTER (WHERE settled_at IS NULL) AS pending
FROM signals WHERE created_at >= now() - interval '7 days' * N;
```

Recovered rows gain `shadow_pnl`/`settlement_price`; genuinely-archived rows
re-earn `unsettleable_404` honestly (correct path this time) and stay excluded.
Stop advancing tranches when a whole week comes back 100% re-poisoned — that is
the true archive horizon (~9,000 outcomes/month accrue from the fix-forward
date regardless).
