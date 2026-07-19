# TradeAgent — Improvement Log

Logged by the `kalshitradeagent-health` scheduled health check. One entry per run when a worthwhile improvement is found.

---

## 2026-07-07 (health run) — Add a retention/prune job for `compliance_log` (unbounded growth in the table the whole system queries)

**Severity:** Medium — no active outage; preventive scaling fix. Today's run is clean: 0 error/critical events in `compliance_log` in the last 24h, hourly health-check all-clear, no error/critical Telegram alerts.

**Telegram-error review this run:** The two error streams that were flooding the channel are both resolved and silent — `auto_trade_strategy_error` (`.catch is not a function`, last seen 2026-07-06 10:05) and `lesson_write_error` (`trade_lessons_lesson_type_check`, last seen 2026-07-06 10:07). Nothing new is coming through. Both root causes and the follow-ups (the `.catch` pre-deploy guard, committing the deployed-but-uncommitted fixes) are already logged in the two prior entries below.

**The improvement:** `compliance_log` has **276,461 rows / 153 MB and no retention policy** — `cron.job` has no prune for it, and no edge function trims it. It has grown ~276k rows since 2026-04-06 (~3 months); at this rate it passes **~1.1M rows / 550 MB+ per year, unbounded**. Two routine telemetry events dominate: `surface_scan_complete` (104,245 rows) and `auto_trade_strategy_run` (103,442 rows) — together ~75% of the table, pure heartbeat noise with no diagnostic value after a day or two.

**Why it matters:** this is the single most-queried table in the system. Every hourly health-check sweep, every `alertOnce` dedup lookup, and the dashboard/performance queries scan it. Letting it grow without bound slowly degrades the exact queries the agent relies on to detect the *next* real failure — the health check quietly gets slower and more expensive as the noise accumulates.

**Proposed fix (pg_cron, low risk, no Hard Stop):** a daily prune that keeps errors/alerts/trades long and trims high-volume routine rows after a short window, e.g.
```sql
-- keep 7 days of routine heartbeats; errors/alerts/trades untouched
delete from compliance_log
where created_at < now() - interval '7 days'
  and severity = 'info'
  and event_type in (
    'surface_scan_complete','auto_trade_strategy_run','auto_trade_run',
    'market_data_fetch','auto_settle_run','weather_signal_run',
    'auto_reflect_run','memory_compaction','cache_stale','health_check_run'
  );
```
Pair it with an index on `(created_at)` if not already present, and consider dropping `surface_scan_complete` to `info` unconditionally (it's currently logged at `warning` whenever any edge ≥10¢ is found, which is an opportunity, not a fault). Tune the window during implementation.

---

## 2026-07-07 (health run) — Add a pre-deploy guard against `.catch()` on a Supabase builder (the bug class that caused the 7-day outage)

**Severity:** Medium — preventive. No active outage; today's run is clean (0 error events in `compliance_log` since 00:00 UTC, hourly health-check all-clear, no error/critical Telegram alerts).

**Telegram-error review this run:** Over 2026-07-03→07-06 the channel carried **26 `system_errors` alerts** (plus 2 trading_silence, 1 win_rate_collapse, 1 cron_failed), all driven by three now-fixed bugs:
- `auto_trade_strategy_error` — `.catch is not a function` on a PostgrestBuilder (97 events) → fixed, last seen 07-06 10:05.
- `auto_settle_error` — same `.catch` footgun in `auto-settle` (9 events) → last seen 07-04 11:12.
- `lesson_write_error` — `trade_lessons_lesson_type_check` violation (80 events) → fixed by migration `20260706_trade_lessons_lesson_type_expand.sql`, last seen 07-06 10:07.
Nothing is coming through today.

**The improvement:** the exact same `.catch()`-on-a-thenable footgun independently took down **two** functions (`auto-trade` and `auto-settle`) and ran for 7+ days before being caught by reactive error alerts. The Supabase `PostgrestBuilder` is a thenable, not a Promise — it has `.then` but no `.catch` — so `builder.catch(...)` throws `TypeError` at runtime and aborts the caller. This is a recurring *class* of bug, not a one-off, and it is invisible to TypeScript. Root-cause fix: a guard so it cannot recur.

**Proposed guard (pre-deploy grep, ~10 lines, no Hard Stop):** fail the deploy step if any edge function chains `.catch(` on a builder without an intervening `.then(`. Add to a `predeploy` script:
```
# flags `.from(...)….catch(` chains that never went through `.then(`/`await`
rg -nP '\)\s*\.catch\(' supabase/functions --type ts | \
  rg -v '\.then\(' && { echo "❌ .catch() on a non-awaited Supabase builder — will throw at runtime"; exit 1; }
```
Tighten the regex during implementation (await'd builders and `fetch().catch()` are fine); the point is a mechanical gate that would have caught both outages before they shipped.

**Why it matters:** on a live-money agent, a runtime footgun that survives type-checking and only surfaces via hourly Telegram spam is exactly the failure mode to make impossible, not to keep re-detecting after the fact.

---

## 2026-07-07 — Commit the deployed-but-uncommitted edge-function fixes (git HEAD is behind production)

**Severity:** Medium — no active outage, but every already-earned fix is one `git checkout`/CI-redeploy away from silently reverting.

**System status this run:** Healthy. Last 24h of `compliance_log` shows the auto-trade runner clean — `"3 ran, 0 traded, 0 errors, 0 halted"` hourly, health-check `all clear`, zero error/critical Telegram alerts. Both prior bugs are resolved *in production*:
- `auto_trade_strategy_error` (`.catch is not a function`) — last seen 2026-07-06 10:05, gone after `auto-trade` v137 deploy (12:49).
- `lesson_write_error` (`trade_lessons_lesson_type_check`, 103 total) — last seen 2026-07-06 10:07, gone after `auto-reflect` v43 deploy; `stale_signal` lessons now write cleanly.

**The gap:** those fixes are deployed to Supabase but **never committed to git**. 13 edge-function files sit modified-but-uncommitted; `git HEAD` still contains the buggy versions:
- HEAD `auto-reflect` has the 6-value `validLessonTypes` array (missing `kelly_mismatch`, `stale_signal`) and **no moat guard** — it silently downgrades those two lesson types to `general`, eroding the learning-loop resolution the product's moat depends on.
- HEAD `auto-trade` still chains `.catch()` on Supabase `PostgrestBuilder` — the exact bug that took both strategies down and spammed Telegram hourly for 7+ days.

**Risk:** any `git checkout .`, `git stash`, fresh clone, or CI redeploy repoints production at HEAD → the `.catch` outage returns and lesson-drop resumes. Days of debugging live only in an uncommitted working tree.

**Action needed (not a Hard Stop — commit to a branch):**
```
cd ~/Documents/Projects/Omii-AI-PM-TradeAgent && git checkout -b fix/live-edge-function-state
git add supabase/functions && git commit   # capture what is actually running in prod
```
Then diff HEAD against each deployed function to confirm parity before the next deploy.

---

## 2026-07-06 — Deploy the staged `.catch`-on-PostgrestBuilder fix (both strategies down) — ✅ RESOLVED 2026-07-07

**Severity:** High — both live strategies fail on every run; drowns Telegram in hourly alerts.

**Symptom (from Telegram / `compliance_log`):** For 7+ consecutive days, every hourly `auto-trade` run logs:
- `auto_trade_strategy_error` — `Strategy "Surface Arbitrage" failed: supabase.from(...).update(...).eq(...).catch is not a function`
- `auto_trade_strategy_error` — `Strategy "Weather Edge" failed: supabase.from(...).insert(...).catch is not a function`
- These trip the hourly `system_errors` health-check alert → a Telegram ping every hour. It is the dominant error noise in the channel.

**Root cause:** Several call sites chain `.catch(() => {})` directly on a Supabase `PostgrestBuilder`. That builder is a *thenable* (has `.then`) but is **not** a real Promise — it has no `.catch` method — so the chain throws `TypeError: ...catch is not a function` and aborts the whole strategy runner before it finishes.

**Fix status:** Already written locally as **uncommitted** changes in `supabase/functions/auto-trade/index.ts` (7 sites: lines ~977, 1101, 1155, 1237, 1245, 1770, 2181, plus a new settled-market cleanup at ~1130). Each `.catch(() => {})` → `.then(null, () => {})`. Working tree verified clean of the pattern. **It has never been deployed** — that is why production still throws.

**Action needed (Hard Stop — requires Onofre):** commit + deploy `auto-trade`:
```
source ~/.omii_env && SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA \
  npx supabase functions deploy auto-trade --project-ref uyfnezxmgwitpzsrnkst
```
Then confirm the next hourly run logs no `auto_trade_strategy_error`.

**Secondary (not fixed):** lower-frequency `lesson_write_error` on trade `2ae0d30e-fc43-4ddb-b0bc-bb61a64100e4` (KXHIGHNY-26JUL02-B99.5) — a DB constraint violation writing a lesson row (`new row for relation "tr…"`). Worth a look once the primary fix ships.
