# Improvement Log

Chronological log of concrete improvements surfaced by health checks and reviews.

## 2026-07-10 (2nd) — `health-check` double-pages every API error: generic `system_errors` sweep + structured `api_error_*` sweep overlap

**Status:** Logged — not yet fixed/deployed (production deploy is a Hard Stop; awaiting go). Found via scheduled health check.

**Health snapshot (live `compliance_log`):** last 24h is clean — 0 new `error`/`critical` rows; last errors were the already-logged self-healing Kalshi 503 blip (07-09 07:36–07:41 UTC). The 07-06 `.catch is not a function` strategy bug (`auto_trade_strategy_error`) that drove ~16 `system_errors` pages across 07-04→07-06 is **resolved** — the query-builder `.catch()` pattern is gone from the code and zero `auto_trade_strategy_error` rows have logged since 07-07. Only page in the last 24h: one `trading_silence` (07-10 03:10, expected paper-mode quiet-day notice). System is healthy; this is an alert-hygiene finding.

**The finding (one API error → two Telegram pages):**
`health-check/index.ts` runs two independent error sweeps over the *same* 2h window against the *same* rows:
- **Block 8** (`:252`) selects `severity IN ('error','critical')` and fires a `system_errors` page.
- **Block 9** (`:295`) selects `event_type IN ('api_error','llm_rate_limit','api_timeout','kalshi_circuit_open')` and fires a provider-specific `api_error_<provider>` page.

A Kalshi API failure logs as `event_type: "api_error", severity: "error"` (`market-data-fetcher/index.ts:112`), so it matches **both** filters and pages twice. Confirmed live: on 07-09 the single 503 blip fired `api_error_kalshi` **and** `system_errors` at the same second — `health_check_alert` rows both stamped `2026-07-09T08:10:07`. Every genuine API error (the inbound-data outages that matter most) double-pages: once with a proper provider/status label, once as a generic "N error(s)" duplicate.

**Root cause:** the generic error-severity sweep (block 8) and the structured API-error sweep (block 9) have overlapping selection sets. Block 9 was added to classify API errors by provider/status (the correct, actionable page), but block 8 was never scoped to *exclude* the API-error event types block 9 now owns — so both fire for the same row. The two sweeps use separate fingerprints (`errors_…` vs `api_error_…`), so cooldown dedup never collapses them.

**Fix (proposed):**
1. Scope block 8 to non-API faults only: add `.not("event_type","in","(api_error,llm_rate_limit,api_timeout,kalshi_circuit_open)")` to the block-8 query so `system_errors` catches only code-fault errors (e.g. the 07-06 `lesson_write_error` / `auto_trade_strategy_error` class), and block 9 solely owns API errors with its richer provider/status labeling.
2. Result: code faults → one `system_errors` page; API errors → one `api_error_<provider>` page; no event double-pages.
3. Composes with the three prior logged fixes — 07-09 (2nd) transient-5xx severity gate, 07-09 (3rd) provider labeling, 07-10 (1st) no-op log flooding — all four target the same goal: one accurate, actionable page per real condition on the channel that must stay trustworthy.

**Why it matters:** the inbound market-data path is the alert channel that must page loudly and legibly on a real Kalshi outage (no data → no trades → no track record, the artifact gating the uncle-capital unlock). Two pages for one event trains the reader to skim or mute — the same alert-fatigue failure mode as the severity/provider findings, but affecting *every* API error rather than only transient blips. Deduping to one page per event is pure signal-to-noise; no trading behavior changes.

**Verification plan before shipping:** after the change, simulate an `api_error` (severity `error`) row and confirm exactly one `health_check_alert` fires (`api_error_kalshi`, not also `system_errors`); simulate a non-API `error` row (e.g. `lesson_write_error`) and confirm `system_errors` still fires; re-check that a real Kalshi outage still produces a single loud, provider-labeled page.

---

Newest first. Each entry: what, why it matters, where, and status.

---

## 2026-07-10 (7th, scheduled health check, ~21:xx UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git):**
- **Errors coming through Telegram — quiet of code bugs.** Trailing 72h `severity=error`: **4 rows, all the same self-healed transient Kalshi `503` weather-series blip** (`KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC); **0 `critical`, zero error/critical since**. Latest `health_check_alert` pages: `trading_silence` (07-10 03:10, benign paper-mode quiet — already specified for a fix in "07-10 2nd"), `api_error_unknown` (07-09 18:10, logged provider-misclassification), the self-healed `api_error_kalshi`/`system_errors` 503 pair (07-09 08:10), `cron_failed` (07-06). **No new code-bug page.** Telegram `getUpdates` empty (webhook-consumed) — `compliance_log` remains the source of truth for the error stream.
- **Git drift unchanged and re-confirmed:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **40 uncommitted paths, 9 edge-function `index.ts`** incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `auto-reflect`. `git show HEAD:…auto-settle/index.ts` carries **0** `daily`-breaker refs; the working tree carries **16** — the live daily-drawdown stop-loss exists only in the working tree, one `git reset --hard` from silent revert.

**The one improvement (unchanged, highest-leverage):** commit the stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it."

---

## 2026-07-10 (8th, scheduled health check, ~22:18 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git):**
- **Errors coming through Telegram — quiet of code bugs.** Trailing 72h `severity in (error,critical)`: **4 rows, all the same self-healed transient Kalshi `503` weather-series blip** (`KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC); **0 `critical`, zero error/critical since**. Latest `health_check_alert` pages: `trading_silence` (07-10 03:10, benign paper-mode quiet — fix specified in "07-10 2nd"), `api_error_unknown` (07-09 18:10, logged provider-misclassification), the self-healed `api_error_kalshi`/`system_errors` 503 pair (07-09 08:10), `cron_failed` (07-06). **No new code-bug page.**
- **System live:** most-recent `compliance_log` row `surface_scan_complete` at 2026-07-10 22:18 UTC; `market_data_fetch` / `auto_settle_run` cycling clean on the minute. Crons green.
- **Git drift unchanged and re-confirmed:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **40 uncommitted paths, 9 edge-function `index.ts`** incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `auto-reflect`. `git show HEAD:…auto-settle/index.ts` carries **0** `daily`-breaker refs; the working tree carries **14** — the live daily-drawdown stop-loss exists only in the working tree, one `git reset --hard` from silent revert.

**The one improvement (unchanged, highest-leverage):** commit the stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it."

---

## 2026-07-10 (6th, scheduled health check, ~17:13 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git, ~17:13 UTC):**
- **Errors coming through Telegram — quiet of code bugs.** Trailing 72h `severity=error`: **4 rows, all the same self-healed transient Kalshi `503` weather-series blip** (`KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC); **0 `critical`; zero error/critical since**. Last-96h Telegram pages: `trading_silence` (07-10 03:10, benign paper-mode quiet — fix already specified in "07-10 2nd"), `api_error_unknown` (07-09 18:10, provider-misclassification, already logged), the self-healed `api_error_kalshi`/`system_errors` 503 pair (07-09 08:10), and `cron_failed` (07-06). **No new code-bug page.**
- **System live and healthy:** latest cron green — `market-data-fetcher: 18/18 series OK, 814 markets cached` (17:11 UTC); `auto-trade: 3 ran, 0 traded, 0 errors, 0 halted, Daily P&L $0.00` (17:05 UTC); health check `1 condition active but suppressed (deduped)` = the benign `trading_silence`.
- **Git drift unchanged and re-confirmed:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **40 uncommitted paths**, 9 of them edge-function `index.ts` incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `auto-reflect`. `git show HEAD:…auto-settle/index.ts` carries **0** `daily`-breaker references; the working tree carries **16** — the live daily-drawdown stop-loss exists only in the working tree, one `git reset --hard` from silent revert.

**The one improvement (unchanged, highest-leverage):** commit the stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it."

---

## 2026-07-10 (5th, scheduled health check, ~16:14 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git, ~16:14 UTC):**
- **Errors coming through Telegram — quiet of code bugs.** Trailing 48h severity counts: 0 `critical`, **4 `error`**, 587 `warning`. All 4 `error` rows are the same self-healed transient Kalshi `503` weather-series blip (`KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC); **zero error/critical since**. Last 72h `health_check_alert` pages: `trading_silence` (07-10 03:10, benign paper-mode quiet day — fix already specified in "07-10 2nd"), `api_error_unknown:api_timeout` (07-09 18:10, already logged provider-misclassification finding), and the transient `api_error_kalshi:503` / `system_errors` pair (07-09 08:10, the self-healed blip). **No new code-bug page.**
- **Warning bucket is 576/587 `surface_scan_complete`** at `warning` severity — the known severity-mislabel + flood (already logged, still below the git-drift fix in priority).
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**, 13 edge functions incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `auto-reflect`. Confirmed this run: `git show HEAD:…auto-settle/index.ts:296` still ships the old per-trade breaker (`lossPct = |pnl|/amount*100`, fires on 100% of losing binary settlements); the live daily-drawdown rewrite exists only in the working tree — one `git reset --hard` from silent revert.

**The one improvement (unchanged, highest-leverage):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it."

---

## 2026-07-10 (4th, scheduled health check, ~15:10 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git, ~15:10 UTC):**
- **Errors coming through Telegram — quiet of code bugs.** Trailing 72h severity counts: 1932 `info`, 875 `warning`, **4 `error`**, 0 `critical`. All 4 `error` rows are the same self-healed transient Kalshi `503` weather-series blip (`KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC); **zero error/critical since**. The 07-06 code bugs (`auto_trade_strategy_error` bare-`.catch`; `lesson_write_error` constraint drift) have **not recurred since 2026-07-06 10:07 UTC**. Latest `health_check_alert` page remains the 07-10 03:10 benign `trading_silence` (already specified for a fix in the 07-10 2nd entry).
- **System live and healthy:** latest cron green — `market-data-fetcher: 18/18 series OK, 814 markets cached` (07-10 15:06 UTC); auto-trade cycling clean (`3 ran, 0 traded, 0 errors, 0 halted`, Daily P&L $0.00) with all three strategies resolving `no_setup` — disciplined decline in a low-opportunity market, not a fault.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**, 13 of them edge functions incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `auto-reflect`. The live daily-drawdown stop-loss still exists only in the working tree — one `git reset --hard` from silent revert.

**The one improvement (unchanged, highest-leverage):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it."

---

## 2026-07-10 (3rd, scheduled health check, ~05:15 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — the `trading_silence` false-page fix is already fully specified in the "07-10 2nd" entry below and needs no restatement.

**Verified this run (live `compliance_log` + git, ~05:15 UTC):**
- **Errors coming through Telegram — quiet of code bugs.** `severity=error`/`critical` rows since 07-09 17:41 UTC: **none** (empty). Only live pages remain the 07-09 transient Kalshi `503`/`api_timeout` clusters (both already logged as distinct findings) and the 07-10 03:10 `trading_silence` benign false page. No new `health_check_alert` since 03:10.
- **System live and healthy:** latest cron green — `market-data-fetcher: 18/18 series OK, 802 markets cached` (07-10 05:11 UTC). Auto-trade cycling clean (`3 ran, 0 traded, 0 errors`) — 24h of disciplined `no_setup` in a low-opportunity market, not a fault.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**. Confirmed this run: working-tree `auto-settle/index.ts` carries **14** `daily`-breaker references, `git show HEAD:…auto-settle/index.ts` carries **0** — the live daily-drawdown stop-loss exists only in the working tree, one `git reset --hard` from reverting.

**The one improvement (unchanged, highest-leverage):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it."

---

## 2026-07-10 (2nd, scheduled health check) — **`trading_silence` gated on raw signal presence pages on healthy quiet markets — gate it on the auto-trade outcome instead. (Standing #1 unchanged: commit the 16 stranded stop-loss edge-function fixes.)**

**Status:** Logged — no code, no commit, no deploy (all Hard-Stop-gated on Onofre's go). This entry *specifies* the fix for the `trading_silence` false page that prior runs flagged as "benign" but never made actionable.

**Errors coming through Telegram (live `compliance_log`, trailing 3d):** 2839 rows — 1959 `info`, 875 `warning`, **4 `error`**. All 4 `error` rows are the same self-healed transient Kalshi `503` weather-series blip (`KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC); **zero error/critical since**. Stream is clean of code bugs. Four `health_check_alert` pages fired in 3d: `system_errors` + `api_error_kalshi:503` (07-09 08:10, off the self-healed 503), `api_error_unknown:api_timeout` (07-09 18:10, already logged 07-09 3rd), and `trading_silence` (**07-10 03:10, the subject of this entry**).

**The finding (false page → alert fatigue on the silence channel):**
The `trading_silence` page fired at 07-10 03:10 UTC ("signals present, check errors") because the agent hadn't traded since 07-09 03:05 (~24h ≥ `SILENCE_HOURS = 24`). But the agent was **working correctly the entire window** — it declined to trade because there was nothing worth trading. Proof from the same 24h of `compliance_log`:
- `auto_trade_run` ran 24 cycles, every one **"3 ran, 0 traded, 0 errors, 0 halted."**
- All three active strategies cleanly returned `no_setup` each cycle: Surface Arb — "Alerts found but all events failed fee hurdle, settled, or already held"; Resolution Fade — "No longshot signals"; Weather Edge — "No weather signals passed filters."
- 95 signals generated on 07-10 / 333 on 07-09 — but signals are *candidate* rows (surface scans, weather forecasts, resolution scans), hundreds/day, the vast majority of which correctly never qualify into trades.

**Root cause (`health-check/index.ts:97-128`):** the silence gate uses `hasSignals` = "≥1 signal row in the last 2h" as its proxy for "there were opportunities the agent should have acted on." That conflates *candidate signal generation* with *actionable qualifying setups*. For opportunistic arb/edge strategies, long stretches with candidate signals but zero qualifying setups are the **normal, healthy state** — so "declined to trade, `no_setup`, 0 errors" is indistinguishable from "broken, should have traded" under the current gate. Every quiet-market day trips this page.

**Fix (proposed):** gate the silence page on the auto-trade *outcome*, not on raw signal presence.
1. Over the silence window, read the trailing `auto_trade_run` rows (they already emit `X ran, Y traded, Z errors, W halted`). Page **only** if auto-trade **errored, halted, or stopped emitting `auto_trade_run` entirely** (cron dead) — i.e. the pipeline is actually broken.
2. **Suppress** when every cycle in the window shows `errors=0 && halted=0 && ran>0` and resolves `no_setup` — that is the agent correctly declining in a quiet market, not silence-from-fault.
3. Keep the loud page for the real failure mode: no `auto_trade_run` row for >N hours (cron/pipeline dead → no data → no trades), which is the exact condition the silence check exists to catch.

**Why it matters:** this is the health-check page most likely to fire falsely — it trips on every low-opportunity day, which for opportunistic arb is many. Training Onofre to swipe away "silence — check errors" erodes trust in the one alert that must stay loud: a genuinely stuck or dead auto-trader (no data → no trades → no track record, the artifact gating the uncle-capital unlock).

**Verification plan before shipping:** replay health-check against the 07-10 03:10 window and confirm it does **not** page (24 clean `no_setup` cycles, 0 errors); synthesize an `auto_trade_run` gap >N hours and confirm it **does** page; synthesize an `auto_trade_run` with `errors>0`/`halted>0` and confirm it pages. Confirm the win-rate and volume-spike checks are untouched.

**Secondary observation (noted, no action):** S-002 "Resolution Fade" has produced **0 trades in 7 days** while S-001 produced 36 and S-005 produced 4 — consistent with its strict longshot filter (`yes_ask 8-11¢, vol≥150, spread≤3¢`) finding no setups, but worth a glance to confirm the filter isn't permanently unsatisfiable rather than merely selective.

**Standing #1 (unchanged from the 07-10 1st entry, still the top capital-control item):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` — the live daily-drawdown stop-loss in `auto-settle/index.ts` exists only in the working tree (`git show HEAD:…auto-settle/index.ts` carries 0 `daily`-breaker refs), one `git reset --hard` from silent revert. Blocked solely on Onofre's "commit it." This outranks the silence-gate fix on severity (capital control > alert hygiene); the silence-gate fix is the *new, concrete* improvement created this run.

---

## 2026-07-10 (scheduled health check, ~03:15 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git, ~03:15 UTC):**
- **Errors coming through Telegram — quiet of code bugs.** Trailing 7d `severity=error` rows: only the self-healed transient Kalshi `503` weather-series blip (`api_error` on `KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC) — **zero error/critical rows since**. The 07-06 code bugs (`auto_trade_strategy_error` bare-`.catch`; `lesson_write_error` constraint drift) have **not recurred since 2026-07-06 10:07 UTC**: the poison trade `2ae0d30e` (KXHIGHNY-26JUL02-B99.5) received its lesson at 07-06 10:30 once `stale_signal` was added to the constraint, and the "Moat guard" at `auto-reflect/index.ts:630` now retries any future `lesson_type` drift as `general`. Only live `health_check_alert` firing is `trading_silence` (benign — surface-arb opportunities correctly fail the fee hurdle, e.g. S-001 ask-side sum 50¢ < required 124¢; agent last traded 07-09 03:05).
- **System live and healthy:** latest cron cycle green — `market-data-fetcher: 18/18 series OK, 814 markets cached` (07-10 03:11 UTC); surface scanner cycling every 5 min (16 alerts / ~544 markets); auto-trade `3 ran, 0 traded, 0 errors`. The 6 `filled` unsettled trades are JUL10-event contracts awaiting real-world resolution today, not stuck.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**, 13 of them edge functions incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `settle-signals`, `auto-reflect`. Confirmed directly this run: working-tree `auto-settle/index.ts` carries 14 `daily`-breaker references, `git show HEAD:…auto-settle/index.ts` carries **0** — the live daily-drawdown stop-loss exists only in the working tree, one `git reset --hard` from reverting.

**The one improvement (unchanged):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it." Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker; redeploy-from-HEAD preserves the live stop-loss behavior.

**Secondary observation (not the headline; logged once, no action):** the `auto-reflect` catch-up loop (`index.ts:436-447`) re-selects any settled trade lacking a lesson (cap 20/run) with no per-trade attempt cap — so a permanently-failing write burns a fresh LLM reflection call every hour and crowds the 20-slot budget (this is what trade `2ae0d30e` did for 4 days before the constraint fix). The constraint-drift fallback patches the one known cause; a `reflect_attempts` counter + dead-letter after N failures would bound the cost for any future cause. Low urgency while the stream is quiet.

---

## 2026-07-10 (scheduled health check, ~02:15 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git, ~02:15 UTC):**
- **Errors coming through Telegram — quiet of code bugs.** Trailing 72h: `error`/`critical` rows are only the self-healed transient Kalshi 503 weather-series blip (`api_error` ×3 on `KXHIGHNY/LAX/AUS`, 2026-07-09 07:36–07:41 UTC; retries recovered, 15/18 series still cached) plus one `api_timeout` on `KXFED` (07-09 17:41, 17/18 cached). **Zero error/critical rows since 07-09 17:41 UTC.** The three `health_check_alert` pages sent map 1:1 to those two transient clusters (`system_errors` + `api_error_kalshi:503` at 08:10; `api_error_unknown:api_timeout` at 18:10) — both already logged as distinct findings ("07-09 2nd" transient-5xx-severity, "07-09 3rd" provider-mislabel). Telegram inbound (`getUpdates`) empty. No code bug in the stream.
- **System live and healthy:** latest cron cycle green — `market-data-fetcher: 17/18 series OK, 746 markets cached`, surface scanner cycling every 5 min (16–17 alerts / ~545 markets). `health_check_run` firing hourly.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**, 13 of them edge functions incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `settle-signals`, `auto-reflect`. `auto-settle/index.ts` still references the daily breaker only in the working tree — git HEAD sits one `git reset --hard` away from reverting the live capital stop-loss.

**The one improvement (unchanged):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it." Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker; redeploy-from-HEAD preserves the live stop-loss behavior.

---

## 2026-07-10 (scheduled health check, ~01:15 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git, ~01:15 UTC):**
- **Errors coming through Telegram — quiet of code bugs.** `error`/`critical` rows trailing 7d: the only recent ones are the self-healed transient Kalshi 503 weather-series blip (`api_error` ×4 on `KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC) — **zero error/critical rows in the ~17h since (nothing after 07-09 08:00 UTC)**. The 07-06 code bugs (`auto_trade_strategy_error` bare-`.catch`; `lesson_write_error` constraint drift) have **not recurred since 2026-07-06 10:07 UTC**. Last three `health_check_alert` pages all off the one 07-09 blip cluster (`system_errors` + `api_error_kalshi:503` at 08:10; `api_error_unknown:api_timeout` at 18:10) — both already logged as distinct findings ("07-09 2nd" transient-5xx-severity, "07-09 3rd" provider-mislabel).
- **System live and healthy:** freshest row `health_check_run` at 07-10 01:10 UTC; inbound data path green — `market-data-fetcher: 18/18 series OK, 814 markets cached` (07-10 01:11 UTC, minutes old).
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**, 13 of them edge functions incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `settle-signals`, `auto-reflect`. The live daily-drawdown stop-loss rewrite still exists only in the working tree — git HEAD sits one `git reset --hard` away from reverting it.

**The one improvement (unchanged):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it." Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker; redeploy-from-HEAD preserves the live stop-loss behavior.

---

## 2026-07-10 (scheduled health check, ~00:20 UTC) — **Idle-verify. Telegram/error stream still clean of code bugs; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git):**
- **Errors coming through Telegram — quiet of code bugs.** `error`/`critical` rows trailing 7d: the only ones are the self-healed transient Kalshi 503 weather-series blip (`api_error` ×4 on `KXHIGHNY/LAX/AUS`, last 2026-07-09 07:41 UTC) — none since. `health_check_alert` pages sent: last three all off that one blip cluster (`system_errors` + `api_error_kalshi:503` at 07-09 08:10; `api_error_unknown:api_timeout` at 07-09 18:10) — both already logged as distinct findings (entries "07-09 2nd" transient-5xx-severity and "07-09 3rd" provider-mislabel). The 07-06 code bugs (`auto_trade_strategy_error` bare-`.catch`; `lesson_write_error` constraint drift) have **not recurred since 2026-07-06 10:07 UTC** — the DB constraint was widened (`20260706_trade_lessons_lesson_type_expand.sql`) and the "Moat guard" at `auto-reflect/index.ts:632` retries any future drift as `general`. Latest cron cycle healthy: `market-data-fetcher: 18/18 series OK, 814 markets cached` (07-10 00:06); auto-trade `3 ran, 0 traded, 0 errors`.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**, 13 of them edge functions incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `settle-signals`, `auto-reflect`. The live daily-drawdown stop-loss rewrite still exists only in the working tree — git HEAD sits one `git reset --hard` away from reverting it.

**The one improvement (unchanged):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it." Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker; redeploy-from-HEAD preserves the live stop-loss behavior.

---

## 2026-07-09 (scheduled health check, 23:14 UTC) — **Idle-verify. Error stream still clean; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git, 23:14 UTC):**
- **Errors quiet of code bugs.** `error`/`critical` rows since 07-08: **4 total**, all the same self-healed transient Kalshi 503 weather-series blip (`KXHIGHNY/LAX/AUS`, 07-09 07:36–07:41 UTC) — **none in the ~16h since**. Three `health_check_alert` pages fired today, all off that one blip cluster (`system_errors` + `api_error_kalshi:503` at 08:10; `api_error_unknown:api_timeout` at 18:10). Both the transient-5xx-at-`error` severity issue and the `api_timeout`→"unknown" provider mislabel are already logged as separate findings (entries "07-09 2nd" and "07-09 3rd"); no new code bug surfaced. The 07-06 bugs (`auto_trade_strategy_error` bare-`.catch`, `lesson_write_error` constraint drift) have **not recurred since 2026-07-06 10:07 UTC**. Telegram inbound (`getUpdates`) empty; webhook unset.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**, 13 of them edge functions incl. `auto-settle` (stop-loss), `auto-trade`, `health-check`, `settle-signals`. The live daily-drawdown stop-loss rewrite still exists only in the working tree — git HEAD sits one `git reset --hard` away from reverting it.

**The one improvement (unchanged):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it."

---

## 2026-07-09 (scheduled health check, 22:14 UTC) — **Idle-verify. Error stream clean; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live capital stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per this log's standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git):**
- **Errors quiet of code bugs.** Trailing 7d `compliance_log`: the only `error`-severity rows are the self-healed transient Kalshi 503 weather-series blip (`api_error` ×4, last 07-09 07:41 UTC) and one `api_timeout` — both upstream, absorbed by the Kalshi circuit breaker. The 07-06 code bugs (`auto_trade_strategy_error` bare-`.catch`, `lesson_write_error` constraint drift) have **not recurred since 2026-07-06 10:07 UTC**: S-001 ran 71 times over the last 3 days with **zero** `auto_trade_strategy_error`, and `stale_signal` now persists to `trade_lessons` (the DB constraint was widened; the "Moat guard" at `auto-reflect/index.ts:630` retries any future drift as `general`). The routine `surface_scan_complete` rows (~2016/7d) remain miscalibrated at `warning` severity (`surface-scanner/index.ts:450`) — a known low-priority observability nit, still ranked below the git-drift fix.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02) on `feat/strategy-stories`; **16 uncommitted modified files**, 13 of them edge functions incl. `auto-settle` (stop-loss), `auto-trade` (the bare-`.catch` crash fix), `health-check`. `git show HEAD:supabase/functions/auto-settle/index.ts:296` still computes the per-trade breaker (`lossPct = |pnl|/amount*100`, fires at `lossPct >= stop_loss_pct`); the live daily-drawdown rewrite exists only in the working tree.

**The one improvement (unchanged):** commit the 16 stranded working-tree edge-function fixes on `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it." Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker (no per-trade `lossPct >= stop_loss_pct` check); redeploy-from-HEAD leaves `auto_stop_loss_triggered` silent across losing settlements.

---

## 2026-07-09 (scheduled health check, ~21:xx UTC) — **New, non-cosmetic finding: the lesson taxonomy has no *winning* category, so 201 wins (38% of all lessons) collapse into `general` and the learning loop can't retrieve "why we won" patterns.**

**Status:** Logged — no code, no commit, no deploy (Hard-Stop-gated on Onofre's go). Found via scheduled health check. The standing #1 improvement is **unchanged and still higher priority** — see the ~20:17 entry: commit the stranded working-tree edge-function fixes so git HEAD (`4a97b1a`, 07-02) stops one `reset` from silently reverting the live daily stop-loss. This entry adds a *second, distinct* improvement on the moat path; it does not replace that one.

**Error stream (live `compliance_log`):** quiet of code bugs. Last-1000-row severity: 683 `info` / 313 `warning` / **4 `error`** — all four the same self-healed transient Kalshi 503 weather-series blip (`KXHIGHNY/LAX/AUS`, 07:36–07:41 UTC). The 07-06 code bugs (`auto_trade_strategy_error` bare-`.catch`, `lesson_write_error` constraint violation) have **not recurred since 2026-07-06 10:07 UTC** and are both resolved (the bare-`.catch` site at `auto-trade/index.ts:1016` is now inert; `stale_signal` now persists to `trade_lessons` — 3 rows — and a "Moat guard" retries any future constraint drift as `general`, so drift events = 0). Telegram inbound (`getUpdates`) empty.

**The finding (learning-loop / moat degradation, live data):**
`trade_lessons` distribution over 528 rows: `general` **201 (38%)**, `signal_quality` 197, `market_timing` 102, `forecast_bias` 23, `stale_signal` 3, `execution` 2. `general` is the single largest bucket — and **all 201 `general` rows are wins** (0 losses). This is not the template fallback firing (0 `lesson_llm_fallback` events in-window; 0 of the 201 use the template's `"IF similar setup…"` rule) — the LLM itself is choosing `general` for winning trades. Root cause: `validLessonTypes` (`auto-reflect/index.ts:458`) and the prompt taxonomy (`:515–523`) list **seven failure modes** (`forecast_bias`, `market_timing`, `stale_signal`, `kelly_mismatch`, `signal_quality`, `execution`, `market_structure`) plus the catch-all `general` — and **no positive category for a winning edge**. The same prompt (`:494`) instructs the model to "reinforce winning patterns," then gives it nowhere to file one, so every win that isn't a specific structural anomaly lands in `general`.

**Why it matters ($ / moat):** per `CLAUDE.md`, the community shared-memory learning loop *is* the moat — "reinforce winning patterns" is half its job. Retrieval keys on `lesson_type`; with 38% of lessons (and effectively 100% of the winning ones) in the undifferentiated `general` bucket, the agent can surface *why it lost* by category but cannot surface *why it won* — the winning-pattern half of the loop is structurally unretrievable. This also silently weakens the future platform-promotion pipeline (high-confidence win lessons are the ones most worth promoting to global memory) and dilutes the one asset gating the uncle-capital unlock: a legible track record of repeatable edge.

**Fix (proposed):** add one or two positive lesson types — e.g. `winning_edge` (structural edge confirmed: surface-arb captured, forecast beat market, timing beat repricing) and optionally `noise_win` (won without identifiable edge — luck, don't reinforce) — to (1) `validLessonTypes` (`:458`), (2) the prompt taxonomy (`:515–523`) with clear win-side guidance so the LLM classifies *how* a win was earned, and (3) the `trade_lessons_lesson_type_check` DB constraint (migration required — the `:456` comment already mandates keeping code and constraint in lockstep; the Moat guard makes this zero-downtime). Separating *earned* wins from *lucky* wins is the point: only the former should reinforce, and only the former should be promotion candidates.

**Verification plan before shipping:** after the change, confirm new winning settlements classify into `winning_edge`/`noise_win` rather than `general`; confirm the `general` share of new lessons drops materially (target: `general` reserved for genuine none-of-the-above, not "any win"); confirm the qualify-prompt memory injection now surfaces `winning_edge` lessons for similar setups; confirm no `lesson_type_constraint_drift` rows fire post-migration (constraint accepts the new values).

---

## 2026-07-09 (scheduled health check, ~20:17 UTC) — **Idle-verify. Error stream clean; the one improvement is unchanged — commit the 16 stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream (per the log's own standing guidance) — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git):**
- **Errors quiet of code bugs.** Most recent `error`-severity rows are the transient Kalshi 503 weather-series blip (`KXHIGHNY/LAX/AUS`, `api_error` after retries, 07-09 07:36–07:41 UTC) plus one `api_timeout` on `KXFED` (17:41 UTC) — both upstream, self-healed. The 07-06 code bugs (`auto_trade_strategy_error` bare-`.catch`, `lesson_write_error`) have **not recurred since 2026-07-06 10:07 UTC**. Last 24h `compliance_log`: 288 `surface_scan_complete` (still the known `warning`-severity mislabel), routine `info` heartbeats, 4 `api_error`. Telegram inbound (`getUpdates`) empty; no webhook set on the global bot.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02); **16 uncommitted modified files**, 13 of them edge functions incl. `auto-settle` (stop-loss), `auto-trade` (bare-`.catch` crash fix), `health-check`. `git show HEAD:.../auto-settle/index.ts:296` still computes `lossPct = |pnl|/amount*100` — the per-trade breaker that fires on 100% of losing binary settlements; the live daily-drawdown rewrite exists only in the working tree.

**The one improvement (unchanged):** commit the 16 stranded working-tree fixes on branch `feat/strategy-stories` so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it." Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker (no `lossPct >= stop_loss_pct` per-trade check); redeploy-from-HEAD leaves `auto_stop_loss_triggered` silent across losing settlements.

---

## 2026-07-09 (scheduled health check, ~18:15 UTC) — **Idle-verify. Error stream clean; the one improvement is unchanged — commit the stranded working-tree edge-function fixes so git HEAD stops one `reset` from silently reverting the live stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). No new finding manufactured against a quiet stream — re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git):**
- **Errors quiet of code bugs.** Trailing 48h: 4 `error`, 588 `warning` — all 4 errors the same transient Kalshi 503 weather-series blip (`KXHIGHNY/LAX/AUS`, self-healed next fetch) plus one `api_timeout` on `KXFED`. The 07-06 code bugs (`auto_trade_strategy_error` ×15, `lesson_write_error` ×11) have **not recurred since 2026-07-06 10:07 UTC** — resolved in the working tree.
- **Trading live & healthy:** 15 `order_filled` + 15 `trade_settled` over 48h, and **zero** `auto_stop_loss_triggered` across all 15 settlements. Under committed `HEAD`'s per-trade breaker (`auto-settle/index.ts:297`, `lossPct >= stop_loss_pct`) every losing binary settlement would have fired one and halted the day. Zero fires = the daily-drawdown rewrite is running live but never reached `HEAD`.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02); **16 uncommitted modified files** incl. `auto-settle` (stop-loss), `auto-trade` (the bare-`.catch` crash fix that stopped the 07-06 strategy errors), and `health-check`. `git show HEAD:.../auto-settle/index.ts` still shows the per-trade breaker. A clean clone / `git reset` / redeploy-from-HEAD silently reverts the capital circuit breaker.

**The one improvement (unchanged):** commit the 16 stranded working-tree edge-function fixes on a branch so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it." Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker; redeploy-from-HEAD leaves `auto_stop_loss_triggered` silent across losing settlements.

---

## 2026-07-09 (scheduled health check, ~later UTC) — **Idle-verify, no new finding. Error stream still quiet; the one improvement to ship is unchanged: commit the stranded working-tree fixes so git HEAD stops one `reset` away from silently reverting the live stop-loss.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). Deliberately manufactures no new cosmetic finding against a quiet stream. Re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git + Telegram):**
- **Errors quiet of code bugs.** Trailing 48h: 1,295 `info`, 581 `warning`, **4 `error`** — all four the same transient Kalshi 503 weather-series blip (`KXHIGHNY/LAX/AUS`, 07:36–07:41 UTC), self-healed next fetch. Upstream, not our bug.
- **Trading live & healthy:** 15 `order_filled` + 15 `trade_settled` over 48h, and **zero** `auto_stop_loss_triggered` — under committed `HEAD`'s per-trade breaker every losing binary settlement would have fired one and halted the day. Zero fires = the daily-drawdown rewrite in `auto-settle/index.ts` is running live, but `HEAD` never received it.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (2026-07-02); 18 uncommitted modified edge functions incl. `auto-settle` (stop-loss) and `auto-trade` (bare-`.catch` crash fix). A clean clone / `git reset` / redeploy-from-HEAD silently reverts the capital circuit breaker.
- **Telegram trade bot inbound still dead:** `getWebhookInfo` shows `last_error: 401 Unauthorized` (since 2026-07-04) — the `verify_jwt` gate on `telegram-webhook`, still awaiting the redeploy from the 2026-07-08 21:08 entry. Outbound alerts (2 `health_check_alert` in 48h) unaffected.

**The one improvement (unchanged):** commit the 18 stranded working-tree edge-function fixes on a branch so the repo of record matches production — the stop-loss rewrite is why this is capital control, not hygiene. Blocked on one decision: Onofre says "commit it." (Secondary, also gated: redeploy `telegram-webhook --no-verify-jwt` to restore operator control.) Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker; redeploy-from-HEAD leaves `auto_stop_loss_triggered` silent across losing settlements.

---

## 2026-07-09 (scheduled health check, ~16:08 UTC) — **Idle-verify with fresh $ evidence: 17 settled trades since 07-07, zero stop-loss fires — the daily-breaker fix is provably live and provably uncommitted. The one improvement is still the Hard-Stop-gated commit.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). This run manufactures **no new finding** — a fresh cosmetic entry against a quiet stream is the slop prior entries warn against. It re-verifies live state and reaffirms the single open improvement with new evidence.

**Verified this run (live `compliance_log` + git):**
- **Error stream quiet of code bugs.** Severity counts over the trailing ~48h (1000 rows): 816 `info`, 180 `warning`, **4 `error`** — and all 4 are the same transient Kalshi 503 weather-series blip (`KXHIGHNY`/`KXHIGHLAX`/`KXHIGHAUS`, `api_error` status 503, 07:36–07:41 UTC), self-healed the next fetch cycle. Upstream, not our bug. No new code errors since 07-06.
- **Trading is live and healthy:** 18 `order_filled` + 17 `trade_settled` over 48h. Crucially, **zero** `auto_stop_loss_triggered` rows across those 17 settlements. Under committed `HEAD`'s per-trade breaker every losing binary settlement (100% stake loss) would have fired one and halted the day. Zero fires = the **daily**-drawdown rewrite in `auto-settle/index.ts` is running live — but git `HEAD` (`4a97b1a`, 2026-07-02) never received it.
- **Git drift unchanged:** `HEAD` = `4a97b1a` (7 days old); **22 uncommitted modified files**, including `auto-settle/index.ts` (the stop-loss) and `auto-trade/index.ts` (the bare-`.catch` crash fix). Live edge functions run the patched code; the repo of record does not. A `git reset`/clean-clone/redeploy-from-HEAD silently reverts the capital circuit breaker.

**The one improvement to act on (unchanged, now with 17 settlements of proof):** commit the 22 stranded working-tree fixes on a branch so the repo of record matches the running system. The stop-loss rewrite is why this is capital control, not hygiene — it is protected today by nothing but an untracked working-tree edit. Blocked on one decision: Onofre says "commit it." Verification after commit: `git status` clean; `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker (no `lossPct >= stop_loss_pct` per-trade check); redeploy-from-HEAD leaves `auto_stop_loss_triggered` silent across losing settlements.

---

## 2026-07-09 (scheduled health check, ~15:10 UTC) — **One persistence gate in `health-check` beats two per-site severity fixes: page on *sustained* conditions, not first occurrence.**

**Status:** Logged — no code, no commit, no deploy (Hard-Stop-gated on Onofre's go). Found via scheduled health check.

**Health snapshot (live `compliance_log`, last ~26h, 1000 rows):** 683 `info`, 313 `warning`, **4 `error`**. All 4 errors are one transient event — `market-data-fetcher: Kalshi 503 on series KXHIGHNY/LAX/AUS (after retries)` at 07:36–07:41 UTC — fully self-healed by the next ~5-min scan. It fired **2 `health_check_alert` pages** (`api_error_kalshi`, `system_errors`) to Telegram for a blip. No new systemic errors; the 07-06 bugs remain resolved. Trading is live (paper): 6 `order_filled`, 6 `trade_settled`, 1 trade/day cadence.

**The improvement (consolidate, don't multiply):**
Today already logged two point-fixes — downgrade `surface_scan_complete` from `warning` (07-09 #1) and downgrade transient Kalshi 5xx from `error` + add a per-series counter in `market-data-fetcher` (07-09 #2). Both are instances of one root cause: **severity is stamped at each log site from a static threshold / status code, with no notion of transient-and-recovered vs. sustained.** The higher-leverage fix is a single **persistence gate in the alerting sweep itself** — `health-check/index.ts:252` (`system_errors`) and the API-error sweep (`:279`) escalate to a page on the *first* qualifying row in the 2h window; the fingerprint/cooldown only de-dupes *repeats*, it never suppresses a lone blip.

**Fix (proposed):** in `health-check`, require a condition to persist across **≥N consecutive health-check runs** (or ≥N occurrences spanning ≥2 scan cycles) before it escalates to a Telegram page; a condition present in the latest sweep but absent in the prior run is logged, not paged. This kills the transient-503 false page at the alerting layer regardless of the log-site's severity, subsumes both open point-fixes into one edit site, and gives every future transient condition the same protection for free. Keeps genuine sustained outages paging within ~2 cycles (~10 min).

**Why it matters:** the inbound market-data page is the one that must stay trustworthy — no data → no trades → no track record (the artifact gating the uncle-capital unlock). Paging on self-healing blips trains us to mute exactly that channel. One central gate is also a smaller, easier-to-approve deploy than N per-site severity edits.

**Verification plan before shipping:** replay the 07-09 07:36–07:41 503 burst → confirm 0 pages; inject ≥N consecutive-cycle failures → confirm exactly one deduped page within ~10 min; confirm `strategy_suspended` / `blocked_series` (genuinely sustained states) still page as before.

**Note — dominant open risk unchanged:** the top action from earlier today still stands — the live-but-uncommitted stop-loss rewrite in `auto-settle/index.ts` is one `git reset`/clean-clone from silently reverting to the broken per-trade breaker. That commit is the highest-leverage next move; this alerting gate is secondary.

---

## 2026-07-09 (scheduled health check, ~evening UTC) — **Git drift's highest-stakes casualty named: the stop-loss fix. Not a new improvement — the missing $ evidence for the one already open.**

**Status:** No code, no commit, no deploy (commit is Hard-Stop-gated on Onofre's go). This run does **not** manufacture a new finding — it sharpens the single open improvement (commit the ~40 stranded working-tree fixes) by identifying its most dangerous member and proving the regression with live data.

**The finding (severity, not novelty):**
The uncommitted working-tree drift already logged today includes `supabase/functions/auto-settle/index.ts` — and that file is the **auto stop-loss**, the agent's primary capital circuit breaker. This elevates the git-drift issue from hygiene to capital control.

- **Committed HEAD (`315664e`, 2026-06-10) ships a broken per-trade stop-loss:** line 296 computes `lossPct = |pnl| / amount * 100`; a binary Kalshi contract loses exactly 100% of its stake on any losing settlement, so `lossPct` is **always 100**. Line 297 `if (lossPct >= stop_loss_pct)` (`stop_loss_pct = 15`) is therefore **true on 100% of losing settled trades** → the **first losing trade of any day halts all trading for that day**. This is the exact anti-pattern the working-tree comment warns against ("binary contracts always lose 100%... use daily PnL instead").
- **Working tree (uncommitted, `M`) has the correct rewrite:** a **daily** drawdown circuit breaker keyed to cumulative `daily_pnl` vs `max_daily_loss`, not per-trade %.
- **Proof the drift is real and the runtime is currently on the fixed code:** losses settled 07-07 (×2) and 07-08 (×1), each a 100%-stake binary loss. Under HEAD's code every one would have fired `auto_stop_loss_triggered` and set `is_trading_halted=true`. Live check: **zero** `auto_stop_loss_triggered` rows after the last-gasp `2026-07-06 21:02` fire, and `risk_state` shows **no active halt**. So the daily-breaker fix was deployed ~07-06/08 — but **only to the live functions, never to git.**

**Why it matters ($ / revenue):** the fix is one `git reset`, clean clone, or CI-deploy-from-HEAD away from silently reverting. A revert re-halts the agent on the first losing binary settlement — which happens nearly every day — killing trade volume and therefore track-record accrual, the artifact gating the uncle-capital unlock. The single most important thing this system does (place trades to build a record) is protected only by an untracked working-tree edit.

**The improvement (unchanged target, now with stakes):** commit the ~40 stranded working-tree fixes on a branch so the repo of record matches the running system — the stop-loss rewrite is the reason this is capital control, not cleanup. Blocked on Onofre saying "commit it." Verification after commit: `git status` clean, `git show HEAD:supabase/functions/auto-settle/index.ts` shows the daily breaker (no `lossPct >= stop_loss_pct` per-trade check), redeploy from HEAD leaves `auto_stop_loss_triggered` silent across losing settlements.

---

## 2026-07-09 (scheduled health check, ~12:05 UTC) — **Idle-verify, no new finding. State unchanged from the 10:10 run: the improvement to act on is still the one Hard-Stop-gated commit — nothing new to manufacture.**

**Status:** No code, no commit, no deploy. This run deliberately adds **no new micro-finding** (a sixth cosmetic entry against a quiet stream would be the slop the 10:10 entry warns against). It re-verifies live state and reaffirms the single open improvement.

**Verified this run (live `compliance_log` + git):**
- **Error stream still quiet of code bugs.** The only `error`/`critical` rows since 2026-07-07 are the same 4 transient Kalshi 503s (`KXHIGHNY`/`KXHIGHLAX`/`KXHIGHAUS`, 07:36–07:41 UTC) — all self-healed, upstream blip, not our bug. Last genuine code error remains 2026-07-06 10:07 UTC.
- **Warning bucket still 100% `surface_scan_complete` noise** (latest row 12:03 UTC) — the mislabel from the 07:10 entry, unchanged.
- **Git drift unchanged and unresolved:** `HEAD` = `4a97b1a` (7 days old), still ships the bare builder `.catch(() => {})` at `auto-trade/index.ts:980`; working tree carries the fix + **40 uncommitted modified files**. Live edge functions run the patched code; git does not. A redeploy from HEAD reintroduces every crash bug.

**The one improvement to act on (unchanged):** commit the 40 stranded working-tree fixes (crash patches + constraint migration) on a branch so the repo of record matches the running system. Blocked on one decision — Onofre says "commit it." Until then, health-check runs should idle-verify, not manufacture.

---

## 2026-07-09 (scheduled health check, ~10:10 UTC) — **The improvement is no longer a code finding — it's an approval. Five consecutive runs have logged findings; the error stream has been quiet for 3 days; every remaining finding is cosmetic and gated behind one Hard Stop: commit the working-tree crash-fixes so `git HEAD` stops shipping the bugs live has already patched.**

**Status:** No code, no commit, no deploy (commit/push = awaiting Onofre's go). This entry deliberately generates **no new micro-finding** — doing so would be slop. It escalates the one durability risk that has sat unresolved across five runs.

**Error picture (verified this run):**
- Telegram is quiet of code bugs. The only alerts in the trailing window were **transient Kalshi 503s** on weather series (`KXHIGHNY`/`KXHIGHLAX`/`KXHIGHAUS`, 07:36–07:41 UTC) that **self-healed the very next fetch cycle** (18/18 series OK at 07:46). Upstream blip, not our bug.
- Zero `error`/`critical` `compliance_log` rows attributable to our code in the trailing 48h. Last genuine code error: `2026-07-06 10:07 UTC`. The two historical crash classes (`auto_trade_strategy_error` bare-`.catch`, `lesson_write_error` 23514) stopped firing three days ago.

**The one durability risk, re-verified (git state, not speculation):**
- `git HEAD` = `4a97b1a` (7 days ago). `git show HEAD:supabase/functions/auto-trade/index.ts` still contains the bare builder `.catch()` at line ~980 — the exact crash that flooded Telegram Jul 2–6.
- The working tree has that line removed and **~20 uncommitted modified files** (all edge functions + the constraint-migration path). Live edge functions run the patched code (that's why the stream went quiet), but **git does not**. A clean redeploy from HEAD reintroduces every crash bug.
- The fixes are stranded in the working tree. They are only durable once committed — and commit is a Hard Stop.

**The improvement to act on:** `git add -A && git commit` the working-tree fixes (crash patches + constraint migration) on a branch, so the repo of record matches the running system. This closes the drift, makes the fixes survivable across a redeploy, and lets the four cosmetic findings below (double-paging, transient-503 gating, `surface_scan_complete` severity mislabel) be handled together in one small follow-up PR. Until this commit happens, further health-check runs will keep producing diminishing findings against an already-quiet stream — the loop should idle-verify, not manufacture.

**Blocker:** one decision — Onofre says "commit it."

---

## 2026-07-09 (scheduled health check, ~09:08 UTC) — **New finding: every Kalshi `api_error` row double-pages Telegram — the health-check's two alert sweeps overlap, so one 503 event fires two separate pages.**

**Status:** Logged — no code/deploy/commit (awaiting Onofre's go). One-line fix (add an exclusion filter to the generic sweep). Distinct from the ~08:10 severity entry below: that one is about *whether* a transient 503 should page at all; this is about the health-check emitting *two* pages for the same row even once it does.

**What the data shows (verified this run):** Today's Kalshi 503 hiccup (4 `api_error`/`error` rows, `KXHIGHNY`/`KXHIGHLAX`/`KXHIGHAUS`, 07:36–07:41 UTC, all self-healed) produced **two** `health_check_alert` rows at the same instant, `2026-07-09T08:10:07`:
- `alert_type: "system_errors"`, fingerprint `errors_api_error_market-data-fetcher: Kalshi 503 …`
- `alert_type: "api_error_kalshi"`, fingerprint `api_error_kalshi:503`

Same underlying event, two Telegram messages.

**Root cause:** the hourly health-check runs two independent alert sweeps over `compliance_log`, and they overlap on exactly this row class:
- `health-check/index.ts:252` — the **generic error sweep** selects `severity in ("error","critical")` over the last 2h and pushes a `system_errors` alert (`:266`). A Kalshi 503 is logged `severity="error"` (per the 08:10 entry), so it matches here.
- `health-check/index.ts:294` — the **structured API-error sweep** selects `event_type in API_ERROR_TYPES` (`:277`, includes `api_error`) and pushes a per-provider `api_error_${provider}` alert (`:318`). The *same* row matches here too.

Because the two alerts carry different `type`/`fingerprint` values, `alertOnce` (dedup keyed on `alert_type` + `fingerprint`) treats them as distinct and sends both. So every `api_error`-severity row is structurally guaranteed to page twice per health-check run — the generic sweep and the structured sweep are counting the same rows.

**Why it matters ($ / moat):** same alert-fatigue thesis as the entries below, but this one *doubles* the page count on the exact rows we already know are mostly transient noise — two red 🔴 pushes for one self-healing hiccup. It also makes the alert stream misrepresent reality: a reader seeing `system_errors` + `api_error_kalshi` back-to-back reasonably infers two problems, not one. The generic `system_errors` sweep exists to catch *non-API* errors (`lesson_write_error`, `auto_trade_strategy_error`, etc.); API errors already have a dedicated, better-structured sweep.

**Fix (one line, reuse the existing structured sweep):** scope the generic error sweep to *non-API* errors so the two sweeps stop overlapping — add `.not("event_type", "in", "(api_error,llm_rate_limit,api_timeout,kalshi_circuit_open)")` to the `health-check/index.ts:252` query (mirror of `API_ERROR_TYPES`). API errors then page **only** through the structured provider-grouped sweep (`:294`), which already carries provider + status + count. Non-API errors keep paging through `system_errors` exactly as today. No coverage lost, one page per event instead of two.

**Verification plan before shipping:** deploy health-check with `SUPABASE_ACCESS_TOKEN_KTA`; on the next isolated Kalshi `api_error`, confirm exactly one `health_check_alert` row (`api_error_kalshi`) is written and no paired `system_errors` row; and confirm a genuine non-API error (e.g. a seeded `lesson_write_error`) still fires its `system_errors` page.

---

## 2026-07-09 (scheduled health check, ~08:10 UTC) — **New finding: single-cycle Kalshi 503s on weather series log as `severity="error"` and page Telegram, though they self-heal next cycle.**

**Status:** Logged — no code/deploy/commit (awaiting Onofre's go). Reuses the circuit breaker already in the file.

**What the data shows (verified this run):** These are the **first `error`-severity rows since 2026-07-06** — and they landed *after* today's earlier 07:10 run, so that run reported "error stream quiet" and never saw them. In the trailing 24h there are exactly **4** `api_error` rows, all HTTP 503, all on weather high-temp series, clustered in two back-to-back 5-min cycles: `KXHIGHNY` at 07:36 and 07:41 UTC, `KXHIGHLAX` + `KXHIGHAUS` at 07:41. Every series recovered the next cycle (782→800 markets cached). This is a ~10-minute upstream Kalshi hiccup, not an outage — the run never tripped `CONSECUTIVE_FAILURE_LIMIT` (3).

**Root cause:** `supabase/functions/market-data-fetcher/index.ts:113` sets
`severity: is429 ? "warning" : "error"` — so every non-429 status (transient-upstream 503/502/504 included) is tagged `error` on the *first* failed cycle. The hourly health-check api_error sweep (`health-check/index.ts:277`, `API_ERROR_TYPES` includes `api_error`) then forwards those `error` rows to Telegram, grouped by provider. Net effect: a self-healing single-cycle 503 on one weather series pages you.

**Why it matters ($ / moat):** identical failure mode to the two prior entries and today's `surface_scan_complete` entry — noise tagged at alert severity trains us to ignore the red 🔴 alerts, precisely when a *persistent* Kalshi outage (the one the circuit breaker exists to catch) is the thing we must not miss. Low volume today (4 rows/24h) so this is hygiene/robustness, not a fire — but it's the wrong default the moment Kalshi has a bad hour.

**Fix (reuse what's already there):** gate severity on persistence, not on the first failure. A transient-upstream status (`502/503/504`) on a single cycle logs at `warning` (below the health-check error sweep, so no page); escalate to `error` + Telegram only when a series crosses persistence — e.g. it fails ≥2 consecutive cycles, or the run trips `CONSECUTIVE_FAILURE_LIMIT`. Keep auth/quota statuses (`401/403/429`) at their current immediate-alert behavior — those *are* actionable on first hit. The `consecutiveFailures` counter this needs already exists a few lines down at `market-data-fetcher/index.ts:128`.

**Verification plan before shipping:** deploy market-data-fetcher with `SUPABASE_ACCESS_TOKEN_KTA`, then confirm a subsequent isolated 503 writes a `warning` (not `error`) row and fires no Telegram page, while a forced 3-consecutive-failure run still trips the breaker and alerts.

---

## 2026-07-09 (scheduled health check, ~07:10 UTC) — **New finding: routine `surface_scan_complete` logs are mislabeled `severity="warning"`, flooding the warning bucket (~288 rows/day) and burying real warnings.**

**Status:** Logged — no code/deploy/commit (awaiting Onofre's go). One-line severity fix.

**What the data shows (verified this run):** In the trailing 48h, `compliance_log` held 1,323 `info` + 576 `warning` rows and **zero** `error`/`critical` — error stream still quiet (last genuine error 2026-07-06 10:07 UTC, unchanged). But **100% of those 576 `warning` rows are `surface_scan_complete`** — a *successful* scan, not a warning. It fires ~288×/day. The pollution is self-demonstrating: this run's first "show me errors/warnings" query returned nothing but scan-complete noise.

**Root cause:** `supabase/functions/surface-scanner/index.ts:450` sets
`severity: filteredAlerts.some((a) => a.expected_edge_cents >= 10) ? "warning" : "info"`.
A scan that merely *found* a ≥10¢-edge opportunity is tagged `warning`. That conflates "high-edge signal detected" (good news, an info/opportunity event) with "something is wrong" (the semantic meaning of `warning`). Any severity-based health query or Telegram warning filter is now unusable without an event_type exclusion list.

**Why it matters ($ / moat):** the whole point of this health check — and of the Telegram alert layer — is that a human can filter to `severity in ('warning','error','critical')` and trust every hit is actionable. Right now that filter is 100% noise, which is exactly the "train ourselves to ignore alerts" failure mode the prior two entries fought. It also inflates `compliance_log` (now 278k rows / 154 MB, growing ~1k/day since April with no retention) with high-severity-tagged rows.

**Fix (one line + one follow-up):**
1. Drop the ternary — always log `surface_scan_complete` at `severity: "info"`. High-edge detections that deserve attention should emit a *distinct* event_type (e.g. `surface_high_edge_alert`) at `info`, not overload `warning`.
2. (Follow-up, separate) add a `compliance_log` retention/eviction job — unbounded since 2026-04-06 violates the memory-budget standard.

**Verify after fix:** `SELECT severity, count(*) FROM compliance_log WHERE created_at > now()-interval '24 hours' GROUP BY 1` — `warning` count should drop to genuine warnings only (near-zero on a healthy day).

---

## 2026-07-09 (scheduled health check, ~06:11 UTC) — **confirming, not adding: the git↔prod drift is still live — every crash-fix that made the error stream quiet exists ONLY in the uncommitted working tree; `git HEAD` still ships the bugs.** This run generated no new finding (per the 05:10 "pause the finding-generator" call); it re-verifies the one durability risk that actually matters.

**Status:** No code, no deploy, no commit (commit/push = awaiting Onofre's go). **Error picture is quiet — unchanged for 3 days:** zero `error`/`critical` `compliance_log` rows in the trailing 48h; last genuine error `2026-07-06 10:07 UTC`. The two historical error classes are both remediated *in the working tree* — `lesson_write_error` (constraint migration `20260706_..._expand.sql` applied + 23514→`general` fallback at `auto-reflect:630` + `alertOnce` dedup) and `auto_trade_strategy_error` (bare-builder `.catch` rewritten to `.then().catch()`).

**What the data shows (verified this run):**
- `git status`: branch `feat/strategy-stories`, **13 edge-function files modified, 326 insertions / 118 deletions, uncommitted.** `git show HEAD:.../auto-trade/index.ts` still contains bare `}).catch(() => {})` on Supabase builders (lines 323, 862, 980, 1104, 1154, 1244, 2180) — i.e. HEAD is the pre-fix code.
- Prod is running the *working-tree* version (deployed edge functions), which is why the stream is quiet. Any clean clone, `git checkout`, or source-based redeploy from HEAD **silently reintroduces the Surface-Arbitrage / Weather-Edge crash storm and the lesson-loop constraint loss.**

**Why it matters ($ / track record):** the paper-trading track record is the artifact gating the family-capital unlock (CLAUDE.md); it accrues only while strategies run un-crashed. The crash-protection is currently one `git checkout` from deletion, with no commit anchoring it.

**The one improvement (awaiting go — a single action):** commit the working-tree edge-function fixes to branch `feat/strategy-stories` (`git add supabase/functions && git commit`) so prod's behavior is reproducible from source. This is purely local, reversible, blocks nothing, and removes the "redeploy reverts everything" risk. Not done autonomously: repo rule is commit/push only when asked.

---

## 2026-07-09 (scheduled health check, ~05:10 UTC) — **the bottleneck is no longer finding improvements, it's shipping them: this log now holds 30+ entries, every one marked "NOT applied / awaiting go," accrued in ~48h — and the single fix that actually stopped the live strategy-crash storm exists ONLY in the uncommitted working tree (`git HEAD` still contains the bug), so any redeploy from source silently reintroduces the crash.** The next health-check finding has near-zero marginal value; the batch of already-verified fixes sitting undeployed is the real risk now.

**Status:** Consolidation/triage entry — no new code, no deploy. **Error picture this run is quiet (unchanged for 3 days):** the two genuine-error classes (`auto_trade_strategy_error`, `lesson_write_error`) have **not fired since 2026-07-06 10:07 UTC** — zero `error`/`critical` `compliance_log` rows in the trailing 72h; live telemetry (last 24h) shows the system fully healthy: 24 `auto_trade_run`, 72 `auto_trade_strategy_run`, 27 `auto_reflect_run`, 9 `order_filled`, 9 `trade_settled`, `health_check_run` "all clear" hourly. This entry is a deliberate stop-generating-findings call, not a live incident.

**The finding — process, not code:** each health-check run since 2026-07-07 has dutifully surfaced exactly one new improvement and logged it as a Hard Stop "awaiting go." That was correct per-run, but the aggregate is now a **30+ deep queue of verified, mostly rollback-able edge-function fixes that never ship**, because each is individually gated and Onofre has to say "go" 30 separate times. Meanwhile the most consequential fix already made — the bare-`.catch()`-on-Supabase-builder removal that stopped Surface Arbitrage and Weather Edge crashing on nearly every 5-min run — is **deployed to prod but uncommitted** (per the 2026-07-08 git↔prod-drift entry): `git diff HEAD` still shows 13 `.catch()` removals across 12 files; `git show HEAD:.../auto-trade/index.ts` still has the bug. The fix survives only until the next `git checkout` / clean-clone / CI redeploy.

**Why it matters ($ / track record):** the paper-trading track record is the artifact gating the family-capital unlock, and it accrues only while the strategies run without crashing. The crash-fix protecting that track record is one `git checkout` away from being lost, and 30 other verified improvements (retention prune, severity normalization, the inbound-webhook `verify_jwt` fix that restores remote `/run`/`/status` control, per-strategy liveness alerts, the cron→function name-drift 404) are all built and waiting. Continuing to generate finding #31 adds noise; shipping the backlog adds durability.

**The one improvement (awaiting go) — a single approved batch, not 30 separate goes:**
1. **Commit the working-tree `.catch()` fix first** (`git add` the 12 edge-function files + `_shared`, commit on a branch off `main`) so the crash-fix can't be lost to a redeploy — this is the only item that is *purely local* and blocks nothing.
2. **Batch-deploy the rollback-able edge-function fixes** in one window (severity demotion, `verify_jwt=false` on `telegram-webhook`, alert-dedup on the lesson-write path, health-check liveness/`net._http_response` sweeps), each a redeploy-to-rollback change touching nothing persistent.
3. **Apply the two DB-DDL items** (compliance_log retention prune job, `trade_lessons`/orphan-column cleanup) as a separate, explicitly-reviewed step, since those are the only genuinely irreversible ones.
4. **Then pause the finding-generator** — future health-check runs report "clean, N fixes still queued" rather than logging a new entry, until the queue drains below a threshold.

**Verification plan:** after the batch deploys, confirm zero `error`/`critical` rows over the next few cycles (baseline already clean), `git HEAD` no longer contains any bare-builder `.catch()`, and a live `getWebhookInfo` on `@KalshiTradeAgentBot` shows successful inbound deliveries once `verify_jwt` is off.

---

## 2026-07-09 (scheduled health check, ~04:10 UTC) — **`compliance_log` has no retention policy at all — 278,034 rows / 154 MB, growing ~944/day, oldest row 2026-04-06 (~94 days) — and 94.2% of it is pure heartbeat: `surface_scan_complete` (37.7%) + `auto_trade_strategy_run` (37.2%) alone are 75% of the table.** Every diagnostic sweep this health check depends on scans an audit table that is ~16:1 noise-to-signal and grows unbounded forever.

**Status:** Logged — NOT applied (retention = a new pg_cron prune job + DDL against the live prod DB → Hard Stop, awaiting go). **Error picture this run is quiet:** the two known genuine-error events (`lesson_write_error`, `auto_trade_strategy_error`) have **not fired since 2026-07-06 10:07 UTC** (none in the trailing 72h); every `health_check_run` in the last 24h reads `all clear`; all 11 pg_cron jobs report `succeeded` on their latest run (verified ~04:07 UTC). Trade bot webhook still returns 401 (the `verify_jwt` finding of 2026-07-08 21:08 — still awaiting deploy, unchanged). This is an infra/observability-cost finding surfaced *by* the health check, not a live incident.

**What the data shows (verified live via `SUPABASE_ACCESS_TOKEN_KTA`):**
- `compliance_log`: **278,034 total rows**, `min(created_at)=2026-04-06`, `max=2026-07-09`, **944 rows in the trailing 24h**. On-disk: **154 MB total / 139 MB table** (`pg_total_relation_size`). Nothing prunes it: a grep of `supabase/` for `delete…compliance_log|prune|retention|cleanup` is **empty**, and no `cron.job` command references compliance/prune/cleanup. The table has grown monotonically for 94 days with no eviction.
- **94.2% is heartbeat** (`261,790 / 278,034`). Full-table top rows: `surface_scan_complete` **104,725 (37.7%)**, `auto_trade_strategy_run` **103,562 (37.2%)**, `auto_trade_run` 23,248 (8.4%), `market_data_fetch` 13,634 (4.9%), `auto_settle_run` 11,996 (4.3%), `weather_signal_run` 9,060 (3.3%). The genuinely audit-worthy events — `trade_settled` (844), `order_filled` (721), `llm_usage` (659), `s005_qualify_decision` (765), and the error/critical rows — together are **<6% of the table**.
- This is the *cause* underneath the severity-mislabel entries in this log (2026-07-08/09 `surface_scan_complete` at `warning`, etc.): even after those events are demoted to `info`, they still get written one-row-per-run forever with no lifecycle. Fixing severity stops them polluting the *warning tier*; it does nothing about the table growing without bound.

**Why it matters ($ / ops):** two compounding costs. (1) **The watchdog scans its own haystack.** Every finding in this log was produced by sweeping `compliance_log`; those SELECTs (already implicated in the health-check's 7–9s runtime, see the 2026-07-08 timeout entry) get monotonically slower and more expensive as the table grows, and a 16:1 noise ratio raises the cost of every manual diagnostic query too. (2) **Unbounded storage/backup growth** on a paid Postgres — 154 MB today, ~+1 MB/day and accelerating with each new strategy/cron, replicated into every backup. STANDARDS explicitly bars unbounded log growth ("Long-term memory uses eviction and summarization before it exceeds a threshold — never unbounded growth"); this is a direct violation on the system's own audit trail. It is *not* a security or trading-correctness bug — severity **Low–Medium** — but it silently taxes the exact observability substrate the whole health-check regime stands on.

**The one improvement (ready to build, awaiting go):**
1. **Tiered retention via a daily pg_cron prune job.** Keep genuine audit events long (errors/critical, `order_filled`, `trade_settled`, `*_qualify_decision`, `llm_usage`, `health_check_alert` — ~90–180d for the track-record/governance trail); prune high-volume heartbeats (`surface_scan_complete`, `auto_trade_strategy_run`, `market_data_fetch`, `auto_settle_run`, `auto_reflect_run`, `memory_compaction`, `weather_signal_run`, `auto_trade_run`) after a short window (e.g. 14d). A single `DELETE FROM compliance_log WHERE event_type = ANY(<heartbeat set>) AND created_at < now() - interval '14 days'` on a nightly `cron.schedule` caps the table at a bounded size while preserving 100% of the reconstructable audit trail. Reclaims ~94% of current volume on first run.
2. **Cut heartbeat write-rate at the source (optional, compounding).** The per-run `surface_scan_complete`/`auto_trade_strategy_run` rows are near-zero diagnostic value at row-per-run granularity — consider sampling (write 1-in-N) or rolling them into an hourly aggregate row, so the table stops accreting 576+ pure-heartbeat rows/day in the first place.
3. **Add a size guard to the health-check itself** — surface `compliance_log` row-count/size in the hourly sweep and `alertOnce` if it crosses a ceiling, so retention drift becomes visible instead of silent (mirrors the "green but dead" pattern this log tracks).

**Where / rollback:** step 1 is a `cron.schedule` + a bounded `DELETE`, applied via the management-API query path with `$SUPABASE_ACCESS_TOKEN_KTA` (never `supabase db push`). Blast radius: deletes only heartbeat rows past the window — no trade, order, settlement, error, or decision row is touched. Rollback = `cron.unschedule` the prune job (deleted heartbeat rows are non-recoverable, but they carry no audit value, which is the entire premise). **Verify after:** first run drops the table toward ~16k rows, subsequent `health_check_run` sweeps speed up, and the audit-worthy event counts (`trade_settled`, `order_filled`, errors) are unchanged pre/post.

---

## 2026-07-09 (scheduled health check, ~03:00 UTC) — **the per-trade lesson-write failure path in `auto-reflect` fired a raw, un-deduplicated `sendTelegramAlert` (one alert per failing trade, per reflect cycle) while every other lesson-write alert in the same file uses the deduped `alertOnce` — this raw path was the amplifier that turned the 2026-07-03→06 `stale_signal` constraint drift into a Telegram alert storm.**

**Status:** Applied locally on branch `feat/strategy-stories` (`supabase/functions/auto-reflect/index.ts:651`) — **NOT deployed** (prod edge-function deploy = Hard Stop, awaiting go). **Error picture this run is quiet:** the two known genuine-error events (`lesson_write_error`, `auto_trade_strategy_error`) have **not fired since 2026-07-06 10:07 UTC** (none in the trailing 48h); every `health_check_run` in the last 24h reads `all clear`.

**What the data shows (verified live):**
- Trailing-7d Telegram alert volume was dominated by `system_errors` (**41 sends**), driven by two now-quiet root causes: `auto_trade_strategy_error` (**96 rows**, `supabase.from().update().eq().catch is not a function` — a bare-`.catch()` on a Supabase query builder in S-001, **already fixed** in current code, grep for the pattern is clean) and `lesson_write_error` (**80 rows**, `trade_lessons_lesson_type_check` 23514 rejecting `lesson_type="stale_signal"` before the constraint was widened — retry-as-`general` guard **already added** at `auto-reflect/index.ts:630`).
- Remaining gap: the retry guard's *failure* branch (`:644`) logged to `compliance_log` **and** raw-sent to Telegram (`:651`) once per trade, with no cooldown — inconsistent with the outer-catch alert at `:734` which correctly uses `alertOnce(..., 2h)`. The DB sweep in `health-check` is deduped; this direct in-function send was not.

**Why it matters ($ / ops):** severity/volume is the signal that separates "look now" from "ignore." An un-throttled per-trade alert means the next persistent lesson-write failure (bad LLM `lesson_type`, future constraint drift, transient DB error) pages once per failing trade per cycle — retraining the operator to mute the learning-loop channel, the exact "genuine alerts get buried" failure this log already tracks.

**The one improvement (applied on branch, awaiting deploy):**
1. **Replace the raw `sendTelegramAlert` at `:651` with `alertOnce`**, fingerprinted on the error message (`.slice(0,60)`) with a 2h cooldown — mirrors the existing deduped alert at `:734`. A persistent failure now pages once per 2h instead of once per trade per cycle; the `compliance_log` error row is still written every time, so nothing is lost from the audit trail.
2. **Deploy when ready:** `source ~/.omii_env && SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA npx supabase functions deploy auto-reflect --project-ref uyfnezxmgwitpzsrnkst`.
3. **Verify after:** force a reflect cycle and confirm at most one Telegram alert per 2h under a simulated write failure; rollback = redeploy prior `auto-reflect` (no schema/data change, zero blast radius).

**Where / rollback:** one-block edit on branch `feat/strategy-stories`; not on `main`, not deployed. Rollback is a redeploy — nothing persistent touched.

---

## 2026-07-09 (scheduled health check, ~03:00 UTC) — **`surface-scanner` logs its routine "scan complete" event at `severity: "warning"` every time a scan finds any alert with `expected_edge_cents >= 10` — i.e. it flags a *good* thing (a high-edge opportunity) as a warning.** ~300 false `warning` rows/24h flood `compliance_log` and any warning-level alert routing, burying genuine warnings — the same "real alerts get buried" failure mode this log already tracks for the lesson/strategy bugs.

**Status:** Logged — NOT applied (this is a one-line severity fix in a live edge function; prod deploy = Hard Stop, awaiting go). **Error picture this run is otherwise quiet:** the two known genuine-error events (`lesson_write_error`, `auto_trade_strategy_error`) have **not fired since 2026-07-06 10:07 UTC** — no new occurrences in the last ~65h; surface scanning itself is healthy (24 alerts / 574 markets, firing on schedule every 5 min). The dedicated bot's `getWebhookInfo` shows `pending=0`, and the global OMII bot's `getUpdates` queue is empty — no error payloads waiting.

**What the data shows (verified live):**
- `compliance_log` filtered to `severity in (error,critical,warning)` returns **almost nothing but `surface_scan_complete`** — 300 rows in the trailing 24h, one per 5-min scan, all `severity="warning"`, all with `message: "Surface scan found N alerts across M markets"`. These are successful completions, not warnings.
- Source: `supabase/functions/surface-scanner/index.ts:450` — `severity: filteredAlerts.some((a) => a.expected_edge_cents >= 10) ? "warning" : "info"`. Because the scanner nearly always surfaces at least one ≥10¢-edge alert in current markets, the ternary resolves to `"warning"` on essentially every run.
- The adjacent `.then().catch()` at line 461 is **correct** usage here (`.then()` returns a real Promise before `.catch()`), so this is *not* another instance of the bare-`.catch()` builder bug logged 2026-07-06 — the severity string is the entire defect.

**Why it matters ($ / ops):** severity is the signal that separates "look now" from "ignore." Tagging ~300 routine successes/day as `warning` trains the operator (and any future Telegram warning-routing) to tune warnings out — the exact reason genuine errors get missed. It also inflates `compliance_log` growth ~300 rows/day for zero informational gain.

**The one improvement (ready to build, awaiting go):**
1. **Make the completion event always `info`** — change line 450 to `severity: "info"`. A scan finishing successfully is informational regardless of edge size.
2. **If high-edge opportunities warrant their own signal**, emit a *separate* `event_type: "high_edge_opportunity"` row (or set a metadata flag) rather than overloading the completion event's severity — so "opportunity" and "problem" never share the `warning` channel.
3. **Verify after deploy:** confirm zero new `warning`-severity `surface_scan_complete` rows over the next few scan cycles, and that `severity in (error,warning,critical)` queries return only genuine issues.

## 2026-07-08 (scheduled health check, ~21:08 UTC) — **the `telegram-webhook` edge function is deployed with `verify_jwt=true` (Supabase default — `config.toml` has no override), so the Functions gateway rejects every inbound Telegram delivery with 401 *before the handler runs*; the bot's own secret-token auth never executes, and all inbound commands (`/status`, `/health`, `/429`, `/run mdf`, `/run trade`, `/help`) have been dead since 2026-07-04.** The operator's remote hand on the agent is silently offline.

**Status:** Logged — NOT applied (prod edge-function deploy = Hard Stop, awaiting go). **Core system CLEAN this run:** all pg_cron jobs `last_status='succeeded'`, none stale, none failed (auto-trade/settle/reflect/signals/health-check green as of ~21:07 UTC); **44 trades + 2,434 signals in the last 7 days**, latest trade 21:05 UTC. This is an **inbound-only** defect — *outbound* alerts (`sendTelegramAlert`, direct `fetch` from other functions) are unaffected, which is why error alerting still fires and this stayed invisible.

**What the data shows (verified live):**
- The dead channel is the **dedicated `KalshiTradeAgentBot`** (`TRADE_TELEGRAM_BOT_TOKEN`), *not* the global OMII bot. `getWebhookInfo`: webhook registered at `…/functions/v1/telegram-webhook?secret=46afd…`, `pending_update_count=0`, `last_error_message: "Wrong response from the webhook: 401 Unauthorized"`, `last_error_date` = **2026-07-04**. Telegram retries, gets 401 each time, drops the update. (This is why prior entries said "no webhook set" — they checked the *global* bot's `getUpdates`; the global bot genuinely has no webhook. The trade bot was never checked.)
- **Live probe** — `POST …/telegram-webhook?secret=46afd…` with a real `/help` payload → **HTTP 401**. But the handler (`telegram-webhook/index.ts:59`) returns **403** for a bad secret and **200** otherwise — it never emits 401. The 401 therefore comes from *above* the handler: the Supabase Functions gateway's JWT check. Telegram sends no `Authorization: Bearer <JWT>`, so the gateway 401s before the function runs.
- `supabase/config.toml` is **empty (0 lines)** — no `[functions.telegram-webhook]` block, so the function inherits the platform default `verify_jwt=true`. Cron-invoked functions are fine because pg_cron passes the service-role key; Telegram cannot.

**Why it matters ($ / ops):** this is the operator's phone-side control of a trading system — `/status` and `/health` for positions/health, `/run trade`/`/run mdf` to force a cycle, without opening a laptop. With it dead, inspecting or nudging the agent requires a full dev session. The moment any strategy flips to **live money**, losing push-button status and manual triggers is an operational risk, not a convenience gap — and it failed silently for four days, exactly the "green but dead" class this log tracks.

**The one improvement (ready to build, awaiting go):**
1. **Redeploy with JWT verification off:** `source ~/.omii_env && SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA npx supabase functions deploy telegram-webhook --no-verify-jwt --project-ref uyfnezxmgwitpzsrnkst`. The function's URL-secret check (`WEBHOOK_SECRET`) is the correct auth for a public webhook and already exists — it just needs to be reachable.
2. **Codify it so a redeploy can't silently re-break it:** add `[functions.telegram-webhook]` / `verify_jwt = false` to the (currently empty) `supabase/config.toml`, so the setting is source-controlled, not a one-off flag.
3. **Verify after:** re-run `getWebhookInfo` (`last_error_message` stops advancing) and send `/status` from Telegram — a reply confirms the round-trip. Rollback = redeploy with default JWT (no schema/data change, zero blast radius).

**Where / rollback:** deploy-only for step 1 (`telegram-webhook/index.ts` unchanged); step 2 is a one-line config edit on a branch. Rollback is a redeploy — nothing persistent touched.

---

## 2026-07-08 (scheduled health check, ~20:15 UTC) — **`parseSettlementDate` cannot parse the crypto-hourly ticker format (`KXBTC-26JUL1017`, day+hour concatenated with no `H` separator), so every crypto trade stores `expiration_time = NULL` — and the 2h-before-close protective auto-exit filters `.not("expiration_time","is",null)`, so it is a structural no-op for 100% of the BTC/ETH book (and 91% of INX).** The pre-close risk exit that exists in code never fires for the strategies that trade most.

**Status:** Logged — NOT applied (code change + prod edge-function deploy; both Hard Stops, awaiting go). **Live error feed CLEAN this run:** zero `error`/`critical` `compliance_log` rows in the last 24h (last was 2026-07-06 10:07 UTC — the already-fixed `.catch`/`lesson_type` drift pair, both now guarded in code); today's auto-trade runs report "0 errors, 0 halted"; all cron sweeps green. **Telegram:** no webhook set, `getUpdates` empty (history aged out) — verified against `compliance_log` + live DB directly, per the standing note in the 18:31 entry. The prior `lesson_type` drift finding is now closed in code (`auto-reflect/index.ts:624-642` drift guard + constraint widened to include `stale_signal`); this is a **distinct, still-latent risk-management defect**, not a live error incident.

**What the data shows (verified live via `SUPABASE_ACCESS_TOKEN_KTA` + regex traced against `auto-trade/index.ts:112`):**
- `trades` NULL-`expiration_time` rate by series: **KXBTC 166/166 (100%), KXETH 121/121 (100%), KXETHD 17/17 (100%), KXINX 213/234 (91%)**; temperature series (`KXHIGH*`) are mostly populated. Book-wide: **590/801 trades (74%) have NULL `expiration_time`**, and **all 12 currently-open (`status='filled'`) positions are NULL** — which is why a naive "expired-but-unsettled" health check returns 0: the timestamp it would key on is empty.
- The live `parseSettlementDate` regex `KX[A-Z]+-(\d{2})(JAN..DEC)(\d{1,2})?(H(\d{4}))?[-T]` was run against the real open tickers: `KXINX-26JUL08H1600` → **MATCH**, but `KXBTC-26JUL1017` and `KXBTC-26JUL0817` → **NULL**. The crypto hourly encodes `<DD><HH>` with no `H` delimiter, so after `JUL` the `(\d{1,2})?` consumes the day and the next char is a digit, not `[-T]` → no match → `expirationTime` passed to `execute-trade` is `null` → stored as `expiration_time || null`. (The INX 91%-NULL gap is a *separate* cause — the parser matches INX, so those NULLs are trades placed by a path/older deploy that didn't pass `expirationTime`; worth a follow-up but not the root cause here.)
- Two protective paths filter these rows out entirely: the **2h-before-close auto-exit** (`auto-trade/index.ts:1350` — `.not("expiration_time","is",null).lt("expiration_time", twoHourExitCutoff)`) and an **expiry-based settle sweep** (`auto-settle/index.ts:394`). Auto-settle's *primary* path keys on Kalshi market status via the `agent_trades_pending_resolution` view (not `expiration_time`), which is why positions still eventually settle and P&L/error feeds look clean — masking the fact that the pre-close exit never runs for the NULL-expiry majority.
- `expiration_ts` is populated on **0/801** trades — a fully dead duplicate column alongside the live `expiration_time`.

**Why it matters ($ / risk):** the 2h auto-exit is a risk-management control — it sells NO positions near expiry to recover premium instead of riding to a binary 0/100 settlement. It is currently a no-op for the entire crypto book and most of the index book, i.e. the highest-frequency strategies (S-001 surface arb on KXBTC/KXETH/KXINX). In **paper** mode this only distorts recovered-premium P&L; the moment any of these strategies flips to **live**, it is a live risk-control gap on the exact instruments that trade most — positions that should have been trimmed pre-close instead settle binary, widening loss variance on the track record that gates the family-capital unlock. It also silently defeats any monitoring keyed on `expiration_time` (a stuck-position watchdog can't be built on a column that's NULL 74% of the time).

**The one improvement (ready to build, awaiting go):**
1. **Make `expiration_time` authoritative, not ticker-parsed.** At `execute-trade` time, take the market's `close_time`/`expiration_time` straight from the Kalshi market payload the trade already fetches, and store that — parsing the ticker string is the fragile step that's failing. Keep `parseSettlementDate` only as a last-resort fallback.
2. **Fix `parseSettlementDate` for the crypto-hourly format** (`KX(BTC|ETH)-<DD><HH>-…`, no `H` delimiter) so the fallback and any historical-backfill path handle it; add a unit test with one real ticker per series (KXBTC, KXETH, KXINX-H, KXHIGH, KXFED) so ticker-format drift is caught in CI, not six weeks later in prod.
3. **Backfill** existing NULL-`expiration_time` open positions from Kalshi (or the fixed parser) so the auto-exit starts covering the live book immediately, and **drop the dead `expiration_ts` column**.

**Where / rollback:** steps 1–2 touch `execute-trade/index.ts` and `auto-trade/index.ts:108` (+ a test file); deploy with `SUPABASE_ACCESS_TOKEN_KTA`, rollback = redeploy prior version (no schema change). Step 3's backfill is an idempotent UPDATE; the column drop is a one-way migration — do it last, after confirming nothing else reads `expiration_ts` (grep shows nothing does). **Verify after:** re-run the NULL-by-series query — KXBTC/KXETH should drop toward 0% on new trades — and confirm the `:00` auto-trade run's `expiringPositions` set is non-empty when crypto positions are within 2h of close.

---

## 2026-07-08 (scheduled health check, ~19:15 UTC) — **strategy S-002 (Resolution Fade) is `active=true`, un-suspended, and funded — but has placed zero trades in ~54 days (since 2026-05-15)**, and the `trading_silence` alarm can never catch it because it keys on the single most-recent trade **across all strategies**, which S-001's hourly fills keep permanently fresh — so a live, funded strategy can flatline for two months completely invisibly

**Status:** Logged — NOT applied (code change + prod edge-function deploy; both Hard Stops, awaiting go). **Live error feed CLEAN this run:** zero `error`/`critical` `compliance_log` rows in the last 24h (last was 2026-07-06 10:07 UTC); all 10 pg_cron jobs report `status='succeeded'` on their latest run (verified ~19:08 UTC); auto-trade/settle/reflect/signals all green. No new Telegram error alerts. This is a **trading-continuity** finding surfaced *by* the health check, not a live error incident — which is exactly why nothing else caught it.

**What the data shows (verified live via `SUPABASE_ACCESS_TOKEN_KTA`):**
- `trades` grouped by `strategy_id`, all-time: **S-002-ea207ba1 = 209 trades, first 2026-04-15, last 2026-05-15** — then nothing. S-001-ea207ba1 (273, last 2026-07-08) and S-005-ea207ba1 (119, last 2026-07-06) are both trading normally. S-002's last three fills were `KXINX-26MAY15H1600-B7362` rows that went to `expired` on 2026-05-15 23:08 UTC; it has produced **zero** rows in the ~54 days since.
- `strategies` row for `S-002-ea207ba1`: **`active = true`, `suspended_until = NULL`, `suspension_reason = NULL`.** So this is **not** an auto-halt (those set `suspended_until`/`reason`) and **not** a manual disable (`active` is still true). It is a *silent stall* — the strategy is enabled and considered live (the 2026-07-08 PM log entry even asserts "S-001/S-002/S-005 all active"), but its signal→qualify→fill path has emitted nothing for two months.
- `health-check/index.ts:85` fetches **one** `lastTrade` with no `strategy_id` filter, and `:114` fires `trading_silence` only when `hoursSinceLastTrade >= SILENCE_HOURS`. Because S-001 fills every hour, the global "last trade" is always minutes old, so the silence alarm is structurally **incapable** of noticing that an individual strategy has gone dark. (Same blind spot the 2026-07-08 01:45 entry found in `win_rate_collapse` — pools all strategies, discards `strategy_id` — but for the *silence* alarm, and here with a live 54-day victim.)

**Why it matters ($ / track record):** S-002 was seeded with $1k at onboarding and is one of three strategies whose combined paper P&L **is the track record gating the family-capital unlock**. A third of the funded strategy roster has contributed nothing for two months, and every dashboard, cron status, and alarm reads green — the failure is 100% invisible under the current monitoring. Worse, it's the *silent* half of the "green but dead" class the whole log obsesses over: `futures-oracle` (17:10 entry) 404s loudly in `net._http_response`; this leaves no error trace at all. Either S-002 has a real bug (its handler/signal source broke on ~05-15) or it legitimately finds no qualifying markets anymore — and **the system cannot tell those apart today**, which is the actual problem. A track record built on "3 active strategies" that is really 2 overstates diversification to the exact audience (the uncle) it's meant to convince.

**The one improvement (ready to build, awaiting go):**
1. **Add a per-strategy trading-liveness check to health-check.** For each `active = true`, un-suspended strategy, compute `hoursSinceLastTrade` **scoped to that `strategy_id`** and fire a `strategy_silent` alert (via `alertOnce`, fingerprinted on `strategy_id`) when an enabled strategy exceeds a threshold (e.g. 48–72h) with no fill. This converts "a funded strategy is dead and no one knows" from invisible to a single deduped page naming the strategy.
2. **Disambiguate stall-vs-no-signal** so the alert is actionable: include, per silent strategy, whether *signals/candidates were generated but none qualified* vs. *no candidates at all* — the first points at the qualify gate, the second at the signal source. (This is the diagnostic the current pooled alarm can never give.)
3. **Triage S-002 specifically** (separate from the guard): pull one recent auto-trade run for S-002 and check whether Resolution Fade is generating candidates that all fail the qualify filter, or generating none — then decide to fix, re-scope, or intentionally retire+de-fund it (and stop counting it as "active" in the track-record story).

**Where / rollback:** step 1–2 touch `health-check/index.ts` only (add a per-strategy loop; no schema change, no trading-path logic) — deploy with `SUPABASE_ACCESS_TOKEN_KTA`, rollback = redeploy prior version. Step 3 is investigation, no deploy. **Verify after:** temporarily set the threshold low and confirm the next health-check run pages `strategy_silent` naming S-002 (and *only* strategies genuinely past threshold), while S-001/S-005 stay silent.

---

## 2026-07-08 (scheduled health check, ~18:31 UTC) — every pg_cron `net.http_post` that invokes an edge function carries **no `timeout_milliseconds`**, so it inherits pg_net's **5000ms default** — and the health-check function, which runs **7–9s**, straddles that line and records a `timed_out` null-status row on ~25% of its hourly runs (≈14 phantom timeouts/day fleet-wide). The invocations still *complete* server-side today, so it's non-fatal — but it is a latent fragility **and** a landmine directly under the top-of-log observability fix.

**Status:** Logged — NOT applied (the fix is a `cron.alter_job` against the live prod DB → Hard Stop, awaiting go; consistent with every prior entry). **Live error feed CLEAN this run:** zero `error`/`critical` `compliance_log` rows in ~48h (last was 2026-07-06 10:07 UTC — the already-deployed `.catch` bug); all 10 pg_cron jobs report `status='succeeded'` on their latest run (verified 18:26 UTC); trading, signals, settlement, and the hourly watchdog all green. **Telegram:** no webhook set, zero pending updates — the bot's alert history has aged out, so this run was verified against `compliance_log`/`net._http_response` directly (the durable source of truth). This is an infra-fragility finding surfaced *by* the health check, not a live incident.

**What the data shows (verified live via `SUPABASE_ACCESS_TOKEN_KTA`):**
- All three cron invocation commands inspected (`health-check-hourly` jobid 15, `market-data-fetcher-cron` 18, `auto-trade-cron` 4) call `net.http_post(url, headers, body)` with **no `timeout_milliseconds` argument** → pg_net applies its **5000ms** default to every cron-triggered function call in the system.
- `net._http_response` last 24h: **14 `timed_out=true` null-status rows**, `error_msg` = `"Timeout of 5000 ms reached…"`. Grouped by cron-minute: **`:10` × 6** (health-check), plus `:01`/`:16`/`:21`/`:31`/`:51`/`:06` singletons (market-data-fetcher, futures-signal, auto-settle at their ticks). So the health-check is the dominant contributor, and other growing functions clip 5s occasionally.
- The health-check **completes anyway**: `health_check_run` "all clear" rows land at `:10:07`–`:10:09` every hour without a gap (last 12h verified) — ~7–9s after the `:10:00` tick. The Deno edge runtime keeps the handler alive after the pg_net client disconnects at 5s, so the sweep finishes and its Telegram/compliance side-effects fire. Only ~25% of runs (the slower ones) cross 5s and log a timeout; the rest finish just under it. **The function is riding the 5s boundary.**

**Why it matters ($ / moat):** three reasons, in ascending order of consequence.
1. **It's a landmine under the #1 logged fix.** The top-of-log `futures-oracle` entry proposes closing the "cron green but function dead" hole by sweeping `net._http_response` for `status_code >= 400 OR status_code IS NULL` and paging on it. As written, that sweep would fire on the health-check's own 5s-timeout row **every hour** (`status_code IS NULL`, `timed_out=true`) — a self-inflicted alert storm that would bury the real 404s it's meant to catch. **This timeout must be fixed first, or the observability fix ships broken.** That interaction is the single most important reason to log this now.
2. **The health check is one added sweep away from being truncated, not just noisy.** It already runs 7–9s and prior entries propose *adding* checks (the `net._http_response` sweep, set-based fingerprinting). Edge functions have a wall-clock ceiling; more to the point, any future refactor that makes the caller *read the response* (or any function whose caller already does) gets its work cut at 5s. Riding the boundary is not a stable place for the one component whose job is to notice when everything else breaks.
3. **Phantom-timeout noise pollutes the very table the observability fix depends on.** ~14 benign `timed_out` rows/day in `net._http_response` are indistinguishable at a glance from a genuinely dead invocation, raising the cost of every future manual sweep of that table.

**The one improvement (ready to apply, awaiting go):**
1. **Give cron invocations a realistic timeout** — add `timeout_milliseconds := 15000` (health-check; 10000 is ample for the fire-and-forget trading crons) to each `net.http_post` command via `cron.alter_job`, so a slow-but-successful run stops recording as a null-status timeout. Low risk, no function deploy, no schema change. Example:
   ```sql
   SELECT cron.alter_job(15, command := replace(
     (SELECT command FROM cron.job WHERE jobid = 15),
     'body := ''{}''::jsonb)', 'body := ''{}''::jsonb, timeout_milliseconds := 15000)'));
   ```
   (verify the exact `body`-arg tail per job before templating; apply per jobid).
2. **Sequencing guardrail (the real point):** land this **before** the `futures-oracle` entry's `net._http_response` null-status sweep — or make that sweep exclude `timed_out=true` self-invocations to `…/functions/v1/health-check`. Otherwise the observability upgrade false-positives on itself hourly.
3. **Trim the health-check's own runtime** so it isn't riding the boundary at all: the sweeps are independent SELECTs run sequentially — running them with `Promise.all` (or capping each with a statement timeout) pulls a 7–9s run back under ~3s and buys headroom for the checks prior entries want to add.

**Where / rollback:** step 1 is `cron.alter_job` per jobid via the management-API query path with `$SUPABASE_ACCESS_TOKEN_KTA` (never `supabase db push`) — rollback = `alter_job` back to the timeout-less command (restores today's harmless-but-noisy state). Step 3 touches `health-check/index.ts` only. **Verify after:** the hourly `:10` `timed_out` rows in `net._http_response` drop to zero, `health_check_run` still lands each hour, and the planned null-status sweep no longer flags the health-check's own invocation.

---

## 2026-07-08 (scheduled health check, ~17:10 UTC) — `futures-signal-cron` has been POSTing to a **non-existent function name** (`futures-oracle`) since deploy, so the entire Fed-funds/KXFED oracle signal source is **100% dead** — every run 404s, yet `cron.job_run_details` reports **"succeeded"**, so the whole failure is invisible to the cron-health monitor

**Status:** Logged — NOT applied (the fix is a `cron.alter_job` against the live prod DB → Hard Stop, awaiting go; consistent with every prior entry). **Live error feed CLEAN this run:** zero `error`/`critical` `compliance_log` rows in 48h (last was 2026-07-06 10:07 UTC); all 10 pg_cron jobs report `status='succeeded'` on their latest run (verified 17:08 UTC); trading, settlement, and the watchdog all green. **This finding does not surface in the error feed at all** — that is precisely the point of the entry. It is **distinct from every prior entry**: the closest neighbor (`daily-digest-cron`, ~line 693) is a *cron that errors and shows `failed`* because of a JSON `|` parse bug; this is a cron that **succeeds** while its target 404s — the inverse failure mode, and a live, unmonitored one.

**What the data shows (verified live this run via `SUPABASE_ACCESS_TOKEN_KTA`):**
- `cron.job` jobid **16** (`futures-signal-cron`, schedule `6,16,26,36,46,56 * * * *` = 6×/hour) POSTs to `…/functions/v1/`**`futures-oracle`**. The deployed function is named **`futures-signal`** — both on disk (`supabase/functions/futures-signal/`) and live (mgmt-API function list shows `futures-signal`, **no** `futures-oracle`). A direct probe confirms it: `OPTIONS …/futures-signal` → **HTTP 200**, `OPTIONS …/futures-oracle` → **HTTP 404**.
- `net._http_response` (last ~6h retained): **36 rows of `{"code":"NOT_FOUND","message":"Requested function was not found"}`, all HTTP 404**, arriving at a steady **6/hour** — an exact fingerprint match to jobid 16's 6×/hour schedule (≈144 dead invocations/day).
- `cron.job_run_details` for `futures-signal-cron`: **`succeeded`** on every run. `net.http_post` only *enqueues* the request and returns a `request_id`; the SQL wrapper succeeds regardless of the eventual HTTP status. The 404 lands in `net._http_response`, which **nothing** (not the cron status, not the health-check sweep) inspects.
- `compliance_log`: **zero `futures_signal_run` rows in 7 days** — corroborating that the function body has not executed at all. The KXFED FedWatch oracle has been generating no signals for the auto-trade S-001 handler.

**Why it matters ($ / moat):** two failures stacked. (1) **A whole signal source is silently offline.** `futures-signal` is the Fed-funds-futures-vs-Kalshi-KXFED cross-market oracle — it fetches CME-equivalent futures, computes meeting-day implied probabilities, and writes divergence signals (>12¢) for the S-001 FedWatch handler to trade. With the cron pointed at a dead name, that entire edge has been contributing **nothing** to the paper track record — the exact artifact gating the uncle-capital unlock — and no one would know from the dashboard. (2) **The cron-health signal is false-green.** Every prior entry in this log is premised on the monitoring stack being trustworthy; here a job reports `succeeded` 144×/day while doing nothing, which means *any* cron whose function 404s, times out, or 500s is invisible to the current health model. That is a systemic hole, not a one-off typo. Severity **Medium–High**: no data/security exposure, but a live, 100%-dead revenue-relevant job masked by a green status light.

**The one improvement (ready to apply, awaiting go):**
1. **Repoint the cron to the real function name** — one statement, low risk, immediately revives the signal source:
   ```sql
   SELECT cron.alter_job(16, command := replace(
     (SELECT command FROM cron.job WHERE jobid = 16),
     '/functions/v1/futures-oracle', '/functions/v1/futures-signal'));
   ```
   (or set the full `command` explicitly). Verify after: the next scheduled tick writes a `futures_signal_run` `compliance_log` row and `net._http_response` shows 200s, not 404s.
2. **Close the observability hole (the real fix) — make cron success mean function success.** The health-check should not trust `cron.job_run_details.status` alone for `net.http_post`-based jobs. Add a sweep of `net._http_response` over the last hour that pages via `alertOnce` on any non-2xx (`status_code >= 400 OR status_code IS NULL`) response to a `…/functions/v1/…` URL, naming the function. This converts the entire "cron green but function dead" class from silent to visible — and would have caught this on day one.
3. **Guardrail against name drift** — a one-line CI/health assertion that every `/functions/v1/<name>` referenced in a `cron.job` command resolves to a deployed function slug (cross-check `cron.job` URLs against the mgmt-API function list), so a rename can't silently orphan a cron again.

**Where / rollback:** step 1 is a single `cron.alter_job` via the management-API query path with `$SUPABASE_ACCESS_TOKEN_KTA` (never `supabase db push`) — no edge-function deploy, no schema change; rollback = `alter_job` back to the old URL (restores the current dead-but-quiet state). Steps 2–3 touch `health-check` + CI only. **Verify after:** `net._http_response` 404-count for `futures-oracle` drops to 0, a fresh `futures_signal_run` row appears, and a deliberately broken cron URL now fires a `cron_http_failed` alert instead of reading `succeeded`.

---

## 2026-07-08 (scheduled health check, midday run) — the `system_errors` health-check alert **builds a 3-error digest (`sample`) and then throws it away**, so a multi-bug incident pages with only the single newest error type named — the second concurrent failure is invisible in the alert *and* deduped-away for 2h

**Status:** Logged — NOT applied (prod edge-function deploy is a Hard Stop; awaiting go). **Live error feed CLEAN this run:** zero `error`/`critical` `compliance_log` rows in 48h (last was 2026-07-06 10:07 UTC); every `health_check_run` from 08:10→15:10 UTC reads "all clear"; 20 trades in the last 72h. No new Telegram error alerts. This is an alert-quality finding surfaced *by* the health check, not a live incident.

**The finding (verified in source):** in `supabase/functions/health-check/index.ts:260-272`, the `system_errors` branch fetches up to 10 recent `error`/`critical` rows, then at **lines 261-263** builds a bulleted 3-row digest into `const sample` — and never references it again. The fingerprint (line 265) and the alert `message` (line 270) both key off **`recentErrors[0]` only**. So `sample` is dead code, and the alert that ships names just the single most-recent error type: `"🔴 [TradeAgent] N error(s): {type[0]} — {msg[0]}"`. (The `sample`-then-use pattern *is* wired correctly two branches up at the blocked-series alert, line 223/230 — this branch just forgot to spend the variable it built.)

**Why it matters ($ / moat):** this exact failure mode already bit us. The **July 5-6 incident** was *two distinct concurrent bugs* — `auto_trade_strategy_error` (17×, the `.catch`-on-builder crash killing Surface Arbitrage) **and** `lesson_write_error` (13×, the constraint-drift jam). Because both wrote `error` rows in the same 2h windows, each `system_errors` page named only whichever fired most recently, and the fingerprint deduped on that one message — so for up to 2h at a stretch the *other* live bug produced **no visible alert at all**. Two revenue-affecting failures were in flight; the watchdog surfaced one at a time. When the agent is actually on fire is precisely when you need the full error set in the first page, not a peephole — a hidden second failure lengthens time-to-diagnosis, and a stalled strategy or jammed learning loop that goes unseen is silent damage to the track record gating the uncle-capital unlock.

**Fix (one line, low risk, behavior-preserving):**
1. **Spend the digest you already built** — at `health-check/index.ts:270`, replace `${recentErrors[0].event_type} — ${recentErrors[0].message.slice(0, 80)}` with the multi-row `${sample}` so all distinct concurrent error types appear in the page.
2. **Fingerprint on the error-type *set*, not just the first row** — at line 265, key on the sorted unique `event_type`s in `recentErrors` (e.g. `errors_${[...new Set(recentErrors.map(e => e.event_type))].sort().join(",")}`) so a *new* second error type escalates a fresh alert instead of being swallowed by the first type's 2h cooldown.
3. **Guard:** the same "compute a `sample`/digest then emit only `[0]`" shape is worth a quick grep across the other alert branches to confirm none share the bug.

**Verification plan before shipping:** deploy `health-check` with `SUPABASE_ACCESS_TOKEN_KTA`; synthesize two distinct `error`-severity `compliance_log` rows in one window (or replay the July 5-6 pair) and confirm the resulting Telegram page lists **both** event types, and that introducing a new second error type fires a fresh alert rather than being deduped under the first.

---

## 2026-07-08 (scheduled health check, evening run) — the **plaintext `api_keys.encrypted_secret` credential path is dead on writes but never retired**: migration to ciphertext is provably 100% complete, yet the misnamed cleartext column and its read-fallback still live in **4 functions** and remain writable — a latent way to resurrect a plaintext Kalshi trading key with an active read path to use it

**Status:** Logged — NOT applied (schema `DROP COLUMN` + prod edge-function deploy; both Hard Stops, awaiting go). **Live error feed CLEAN this run:** zero `error`/`critical` `compliance_log` rows in 24h (last was 2026-07-06 10:07 UTC); every `health_check_run` since 09:10 UTC reads "all clear"; last trade 2026-07-08 08:05 UTC, last signal 14:53 UTC — trading, signals, and the watchdog all green. No new Telegram error alerts. This is a security-hardening finding surfaced *by* the health check, not a live incident.

**The finding (verified against the live DB, no secret values read):** `api_keys.encrypted_secret` is a **plaintext** column despite its name — `_shared/kalshi-auth.ts:109` assigns it directly to `privateKey` with no decryption. The AES-256-GCM migration to `secret_ciphertext`/`secret_iv` is **complete and confirmed**: a `count(*) FILTER` sweep of `api_keys` returns **0 rows** with `encrypted_secret` populated across all 4 providers, and the live `kalshi_live` row is on ciphertext. Both write paths now hardcode the column to null (`save-kalshi-key/index.ts:74`, `save-ai-key/index.ts:81`) — **nothing writes it anymore.** But the plaintext **read-fallback was never removed** — it is still live in four places: `_shared/kalshi-auth.ts:103-109` (Kalshi trading key), `auto-trade/index.ts:2586`, `trading-agent/index.ts:759`, and `compact-memory/index.ts:49` (AI provider keys) — and the column itself is still a writable part of the schema.

**Why it matters ($ / moat / security):** this is dead-but-loaded. A cleartext column that (a) no longer holds data and (b) has no remaining writer, but (c) still has four active read paths wired to *use* whatever lands in it, is a footgun with the safety off: any future bug, a hand-run `INSERT`/backfill, or an RLS/injection gap that writes `encrypted_secret` would silently store a **live Kalshi trading credential in the clear** — and the read-fallback would happily pick it up and trade with it, no decryption, no alert. It also needlessly widens the blast radius of any read exposure of `api_keys` (a plaintext-secret column is a strictly worse thing to leak than ciphertext). The migration did the hard 99%; the last 1% — retiring the path — is what actually closes the exposure. Trading credentials are the highest-value secret in the system; leaving a cleartext lane open to them undercuts the regulatory/trust posture the whole track-record play depends on.

**Fix (retire the path now that migration is provably done — defense in depth):**
1. **Remove the four read-fallbacks** — delete the `if (!privateKey && data?.encrypted_secret)` branch at `kalshi-auth.ts:103-110` and the equivalent `?? row.encrypted_secret` reads at `auto-trade:2586`, `trading-agent:759`, `compact-memory:49`. Stop `select`-ing the column. If a row somehow lacks ciphertext after this, fail loud (surface a `credential_missing_ciphertext` alert) rather than silently reaching for a plaintext lane.
2. **Drop the column** — `ALTER TABLE api_keys DROP COLUMN encrypted_secret;` via the management-API query path, after confirming (re-run the `count(*) FILTER` sweep) it is still 0-populated at deploy time. This makes the plaintext lane un-writable, not just unused.
3. **Guard against reintroduction** — a one-line CI/test assertion that `encrypted_secret` is not a column of `api_keys` (query `information_schema.columns`) so no future migration silently re-adds a cleartext secret column.

**Verification plan before shipping:** re-run the populated-count sweep immediately pre-drop (must be 0); deploy the read-path removal first and confirm `kalshi-ping` + a paper `auto-trade` cycle still authenticate against the ciphertext path (the live key is already there); then drop the column and confirm no function errors on the next full cron cycle. Rollback = re-add a nullable column (no data lost, since it's provably empty).

---

## 2026-07-08 (scheduled health check, PM run) — `surface_scan_complete` logs a **routine completion event at `warning` severity**, flooding the compliance_log warning tier and burying real operational warnings

**Status:** Logged — NOT applied (prod edge-function deploy is a Hard Stop; awaiting go). **Live error feed CLEAN this run:** zero `error`/`critical` rows since 2026-07-06 10:07 — the `.catch`-on-builder and `lesson_write_error` failures from the prior log entries **stopped firing after deploy** (auto-trade now reports "3 ran, 0 errors" hourly through 2026-07-08 14:05, S-001/S-002/S-005 all active). No new Telegram error alerts. This entry is an observability finding surfaced *by* the health check, not a live incident.

**The finding (self-demonstrating):** the first `severity in (warning,error,critical)` sweep of `compliance_log` over 72h returned 50 rows — **all 50 were `surface_scan_complete`**, a routine "Surface scan found N alerts across M markets" summary. At `surface-scanner/index.ts:450` the severity is `filteredAlerts.some(a => a.expected_edge_cents >= 10) ? "warning" : "info"` — so any scan that finds a ≥10¢-edge detection (i.e. most scans) writes its completion event at `warning`. This is a normal, expected, non-actionable event: the actual opportunity it refers to already lives in the `surface_alerts` table and is what drives auto-trade. Logging the summary at `warning` duplicates that signal and pushes genuine warnings below it.

**Why it matters ($ / moat):** the warning tier is exactly what a human eyeball and the health-check sweep filter on. In the same 72h window it buried an `auto_stop_loss_triggered` (KXBTC lost 100%, trading halted) and a `cron_failed` (daily-digest) under 50 scan-complete rows — the two events you actually want surfaced were needle-in-haystack. Same alert-fatigue failure mode the prior entries flagged, one layer down (severity mislabel vs. re-fire loop). A stop-loss halt or cron death slipping past unseen directly risks silent revenue stops and gaps in the track record gating the uncle-capital unlock.

**Fix (one line, low risk, behavior-preserving for trading):**
1. **Demote the completion event to `info` unconditionally** — `surface-scanner/index.ts:450`: drop the `expected_edge_cents >= 10 ? "warning" : "info"` ternary, always `severity: "info"`. The scan-complete row is a heartbeat, not an alert; nothing keys off its severity except log filtering.
2. **If a high-edge opportunity genuinely warrants paging,** raise it as its own distinct `event_type` (e.g. `surface_high_edge_opportunity`) via `alertOnce` on the specific market — don't overload the scan's completion summary to carry that meaning.
3. **Verification after deploy:** confirm the `warning`-tier `compliance_log` sweep returns only genuinely actionable rows (stop-loss, cron, strategy, rate-limit) and no `surface_scan_complete` over the next few scan cycles.

---

## 2026-07-08 (scheduled health check) — auto-reflect has **no per-trade failure ceiling**; give trades the same self-quarantine strategies already have, so one un-writable trade can't re-flood Telegram forever

**Status:** Logged — NOT applied (code change + prod edge-function deploy; both are Hard Stops, awaiting go). **Live error feed CLEAN this run:** no new `lesson_write_error` / `auto_trade_strategy_error` alerts since 2026-07-06 (~2 days clean). Last 3 days of `health_check_alert` records are the tail of the now-fixed enum-drift flood, plus one `cron_failed` (`daily-digest-cron`, Jul 5) and two `trading_silence` days (Jul 5–6). This entry is preventive, not reactive.

**The finding — the flood was a symptom of a missing structural guard, not just the enum bug:** `auto-reflect/index.ts:438-444` selects settled trades with no lesson ("orphans") — explicit comment *"No time limit — recovers from schema bugs, function crashes, or window misses"* — and re-picks the 20 most recent every cycle. That recovery behavior is correct but has **no escape hatch**: a trade that can *never* write a lesson (constraint reject, LLM permanently failing on it, malformed row) stays a permanent orphan, gets re-picked every ~3h forever, and re-fires `lesson_write_error` each time. That is exactly what trade `2ae0d30e…` did for ~5 days — the enum fix cured *that* trade, but the re-pick-forever mechanism is still live for the next one. Strategies **already** have this guard: `quarantined_at` (selected at :50) lets a repeatedly-failing strategy remove itself from rotation. Trades have no equivalent.

**Why it matters ($ / moat):** the flood isn't cosmetic — 14 of 16 alerts over 3 days were one stuck trade, and a genuinely new signal (the `cron_failed` on the daily digest) fired *once* inside that noise where it is trivially missed. Alert fatigue on the trading agent directly risks missing a real trading or settlement failure, and the track record is the artifact gating the uncle-capital unlock. A per-trade ceiling makes the learning loop self-healing instead of self-flooding.

**Fix (mirror the strategy pattern, defense in depth):**
1. **Per-trade failure counter + quarantine** — `reflection_failures int default 0` + `reflection_quarantined_at timestamptz` on the trades table (mirrors `quarantined_at` on strategies). Increment on each failed lesson-write; at a threshold (e.g. 3), set `reflection_quarantined_at` and **exclude quarantined trades from the orphan query at :438**.
2. **Alert once, at quarantine time** — fire a single `trade_reflection_quarantined` alert via `alertOnce`, then go silent for it. Converts "re-fire every 3h forever" into "one escalation, then muted."
3. **Surface, don't bury** — show quarantined-trade count on the health-check/digest so a stuck learning signal is cleared manually, not silently dropped.

**Verification plan before shipping:** after deploy, force a trade to fail reflection (temp invalid `lesson_type` on a staging row), confirm it increments to threshold, quarantines, fires exactly one alert, and is skipped by later cycles — and that a normal orphan still reflects on the next run.

---

## 2026-07-08 (health check, ~09:08 UTC) — `lesson_type` code↔DB sync is only **comment-enforced**; add a machine guard so the enum-drift flood can't recur

**Status:** Logged — NOT applied (adds a test + CI step to this repo; committing is a Hard Stop, awaiting go). **Telegram / error feed CLEAN this run:** the two errors that flooded the feed last week — `auto_trade_strategy_error` (97 rows) and `lesson_write_error` (80 rows) — both stopped at **2026-07-06 10:07 UTC** and have not recurred (~47h clean). Live `compliance_log` today shows only healthy `auto_trade_run` / `market_data_fetch` rows, 0 errors per cycle.

**Verified fully closed (the reactive side):** the enum-drift fix landed *and* is durable — migration `supabase/migrations/20260706_trade_lessons_lesson_type_expand.sql` is committed, the live DB `trade_lessons_lesson_type_check` constraint now lists all 8 types, `stale_signal` (3) and `execution` (2) lessons now insert successfully, and the previously-stuck trade `2ae0d30e…` was backfilled (lesson `stale_signal` written 2026-07-06 10:30 UTC). This finding is *not* that fix — it's the missing guard around it.

**The finding — the invariant is enforced by a comment, not by code:** `auto-reflect/index.ts:456` reads `// Single source of truth — MUST MATCH the trade_lessons_lesson_type_check constraint in the DB`, and line 458 hardcodes `validLessonTypes = [...8 types]`. The DB constraint is a *separate* hardcoded list in a migration. They agree **today** (8 = 8), but nothing asserts they stay in agreement. This is exactly the failure mode that already fired: the code array was widened, the DB CHECK was not, the LLM emitted `stale_signal`, code accepted it, Postgres `23514`-rejected the INSERT — and auto-reflect re-picked, re-failed, and re-alerted the same trade hourly for ~5 days. The moment anyone adds a 9th `lesson_type` to the code array without a matching migration, the learning loop jams again the same way — and the learning loop (trades → lessons → `agent_memory` → better returns) *is* the moat.

**Fix (defense in depth — convert the comment into a machine invariant):**
1. **Single source of truth in code:** extract `validLessonTypes` to `supabase/functions/_shared/lesson-types.ts`; import it in both `auto-reflect` (validation) and the prompt's allowed-values list so they can't drift from each other.
2. **Assert code == DB:** add a test (the repo already runs `*.test.ts` in CI) that queries `pg_get_constraintdef('trade_lessons_lesson_type_check')` and asserts its value-set equals the shared array — build fails on drift. Cheap CI-only variant: a `ci.yml` step that runs the same query and `diff`s it against the checked-in list.
3. **Optional hardening:** have auto-reflect fall back to `general` (it already does at :554) *and* emit a single deduped `lesson_type_unknown` warning rather than letting an out-of-enum value reach the INSERT — so a future gap degrades gracefully instead of flooding.

**Verification plan before shipping:** add the test, confirm it passes against the current live constraint; then locally add a fake 9th type to the code array only and confirm the test *fails* (proving it catches drift); revert. No production deploy required for the test itself.

---

## 2026-07-08 (health check, ~08:10 UTC) — the `.catch()`-on-builder fix is **live in prod but never committed**: git HEAD still ships the crashing code, so any redeploy-from-source silently reintroduces the Telegram flood

**Status:** Logged — NOT applied (committing/pushing is a Hard Stop, awaiting go). **Telegram / error feed is CLEAN this run:** zero `error`-severity `compliance_log` rows and zero `health_check_alert` rows in the last 24h; the `.catch()`-on-builder crash class (`auto_trade_strategy_error`) and the `trade_lessons` constraint `lesson_write_error` both stopped at **2026-07-06 10:07 UTC** and have not recurred (~46h clean). Trading is live and healthy — `order_filled` at 2026-07-08 08:05 UTC, auto-trade/settle/reflect all green.

**The finding — git↔prod drift, distinct from every prior entry:** prior entries note the `.catch()` fix "appears deployed." It is deployed — but it exists **only in the uncommitted working tree**. `git diff HEAD` removes **13 bare-builder `.catch()` calls across 12 edge-function files** (`auto-trade`, `auto-reflect`, `auto-settle`, `daily-digest`, `settle-signals`, `weather-signal`, `execute-trade` via `_shared`, `health-check`, `surface-scanner`, `_shared/telegram.ts`, `_shared/trading-logic.ts`, `_shared/cors.ts`). Git **HEAD (2026-07-02, last commit) still contains the bare-builder `.catch()`** — verified: `git show HEAD:.../auto-trade/index.ts` still has ≥1. No prior log entry concerns version-control state; they all concern runtime/DB logic.

**Why it matters ($ / track record):** the deployed edge functions are the *only* copy of the fix that stopped both live strategies (Surface Arbitrage, Weather Edge) from crashing on nearly every 5-min run and flooding Telegram hourly. A `git checkout`, a fresh clone, a CI redeploy, or `supabase functions deploy` from a clean tree reintroduces the exact bug — no track record accrues while the strategies crash, and the paper-trading track record is the artifact gating the family-capital unlock. The fix currently survives only as long as nobody redeploys from source.

**Fix (one action, low effort):** commit the 12 modified edge-function files with a message documenting the `.catch()`-on-`PromiseLike`-builder root cause, so version control matches production. Then (separately) add the CI grep-guard the 2026-07-06 entry already prescribed to block `.catch(` chained on a `from(...)` builder. No prod change, no DB change — pure version-control hygiene closing a live regression window.

**Verification after committing:** `git show HEAD:supabase/functions/auto-trade/index.ts | grep -cE '\.eq\([^)]*\)\.catch\('` returns `0`, and `git status` shows the 12 function files clean.

---

## 2026-07-08 (health check, ~06:12 UTC) — auto-settle's **only** input, the `agent_trades_pending_resolution` view, hard-filters `action = 'buy'`, so the settlement engine is structurally **blind to every `sell`/exit fill** — a filled exit leg can never be settled and would sit `filled` forever with unbooked P&L

**Status:** Logged — NOT applied (fix is a view/DDL change against the live prod DB → Hard Stop, awaiting go; consistent with prior entries). **Telegram / error feed is CLEAN this run:** zero `error`/`critical` `compliance_log` rows in the last 48h; the two Jul 5–6 error classes (`auto_trade_strategy_error` from `.catch()`-on-builder crashes, and the `trade_lessons` constraint-violation `lesson_write_error`) both **stopped firing at 2026-07-06 10:07 UTC and have not recurred** — the fixes those entries prescribed appear deployed. All **10 pg_cron jobs succeeded**, zero failures in 48h. Auto-trade/settle/reflect all green.

**This entry is distinct from every prior entry.** Prior settlement-path entries cover NULL `expiration_time` reachability (07-07 06:12), `pnl:0`-on-force-expire (07-07 05:12), and idealized paper fills (07-07 20:20). **None concerns the `action='buy'` filter that scopes *which* trades the settler ever considers.**

**What the data shows (verified live this run via `SUPABASE_ACCESS_TOKEN_KTA`):**
- View definition (`pg_get_viewdef`): `... WHERE mode='paper' AND status='filled' AND action='buy' AND settled_at IS NULL ...`. The `action='buy'` predicate silently excludes any non-buy row.
- `auto-settle/index.ts:73–75` reads **exclusively** from this view to build its (ticker, trade_ids) work-list; nothing else feeds settlement. A trade absent from the view is never checked against Kalshi and never transitions out of `filled`.
- Trade-status reality confirms the blind spot is real, not theoretical: `action='sell'` rows exist (**48 total**) and are **100% `status='expired'` — zero ever reach `settled`.** Every buy leg settles; no sell leg ever does. The settlement engine has only ever booked entry legs.
- Not currently orphaning a live position (0 `sell` rows are `filled`/unsettled right now — the 12 stuck `filled` trades are all `buy`, all legitimately pre-settlement: their tickers resolve `26JUL08`/`26JUL10`, i.e. later today or Jul 10). So this is **latent, not firing** — but unguarded.

**Why it matters (correctness / $):** S-002 has a 12h time-based auto-exit and S-001 places multi-leg baskets; the moment any exit path writes a `sell` fill expecting resolution P&L (rather than routing exits through force-expire), that position becomes permanently stuck `filled` and its realized P&L never lands in the track record — the exact artifact gating the uncle-capital unlock. It also means the current "sells only ever expire" behavior is an **unstated, untested invariant**: nothing documents or enforces that exits must go through the expire path rather than settle, so a future change to the exit logic breaks settlement silently.

**The one improvement (awaiting go):**
1. **Decide the intended invariant and make it explicit.** Either (a) sells are *meant* to settle → widen the view to `action IN ('buy','sell')` and confirm `computePnl` handles the sell side, or (b) sells are *meant* to exit via force-expire only → add a guard/comment at the write site and a test asserting no `sell` row is ever left `filled` past its exit window.
2. **Add a settlement-coverage guard:** a cheap health-check assertion that flags any `status='filled' AND settled_at IS NULL` row older than its market's resolution time — so a position that falls out of the settler's scope (for *any* reason, not just this filter) pages instead of silently accruing.

---

## 2026-07-08 (health check, ~05:10 UTC) — `surface_scan_complete` is logged at `severity: "warning"` on **every single scan** (288/288 in the last 24h), so the entire `warning` severity tier is 100% occupied by one routine, informational completion event — the `warning` level now carries **zero signal** and no genuine mid-severity condition could ever surface in it

**Status:** Logged — NOT applied (edits + redeploys the `surface-scanner` edge function → Hard Stop, awaiting go; consistent with every prior entry). **Telegram / error feed is CLEAN this run:** zero `error`/`critical` rows in the last 24h (both Jul 5–6 error classes — the `.catch()`-on-builder strategy crashes and the `trade_lessons` constraint violation — stopped firing at 2026-07-06 10:07 UTC and have not recurred); auto-trade is running hourly and healthy (latest `auto_trade_run` 05:05 UTC: "3 ran, 0 errors", trades still filling — `order_filled` present, one trade executed at 03:05 UTC). This entry is **distinct from every prior entry**: those concern *which* condition to detect, alert cadence/dedup, aggregation correctness, RLS, memory→EV, cron-existence, or (the 04:15 entry today) alert-payload encoding integrity. **None is about a log source over-classifying its own severity** — a `warning` that is always on.

**What the data shows (verified live this run via `SUPABASE_SERVICE_KEY`):**
- `compliance_log`, last 24h: **288 `surface_scan_complete` rows, all 288 at `severity: "warning"` — a 100% split, and they are the *only* `warning`-severity rows in the window** (288 total warning rows, 288 of them this one event). Zero `info`-severity `surface_scan_complete` rows exist.
- `surface-scanner/index.ts:450` sets `severity: filteredAlerts.some((a) => a.expected_edge_cents >= 10) ? "warning" : "info"`. The `info` branch is **effectively dead**: finding ≥10¢ mispricings is the scanner's entire purpose, so on every ~5-min run at least one filtered alert clears 10¢ and the ternary always resolves to `"warning"`. The condition meant to make a scan *stand out* is the scan's *normal steady state*.

**Why it matters (operability):** severity is a controlled vocabulary and its value is discrimination — `warning` is supposed to mean "notable, not yet an error." Here it means "a scan finished," 288×/day, forever. Two concrete costs: (1) **a real future `warning`** — a genuinely anomalous scan, a degraded-but-not-failed dependency — is born invisible, buried 1-in-288 in identical routine rows; (2) **any dashboard, query, or alert rule keyed on `severity >= warning`** (a standard, reasonable filter) gets 288 false positives/day and can never be made useful. This is the same root failure mode the rest of this log fights — noise devaluing a signal channel — but at the *source-classification* layer rather than the alert-delivery layer. Direct-$ Low (health-check Telegram sweep keys on `["error","critical"]` at `health-check/index.ts:255`, so this does **not** currently flood the phone); operability Medium — it silently renders one of three severity tiers meaningless.

**The one improvement (ready to apply, awaiting go):**
1. **Log `surface_scan_complete` at `info` unconditionally** — it is a routine completion event; the count/edge detail already lives in `metadata`, so nothing observable is lost. One-line change at `surface-scanner/index.ts:450`.
2. **If a genuinely notable scan is worth flagging, gate `warning` on an *abnormal* condition, not the ever-present ≥10¢ one** — e.g. alert count spiking above a trailing baseline, or a rare edge threshold (≥25¢), so the `warning` tier once again means "look at this." (Recommend shipping #1 alone first; #2 only if there's a real consumer for a scan-level warning.)
3. **Guardrail:** reserve the CI/observability check that `warning`-tier rows stay well below `info`/`error` volume, so a future event can't silently colonize the tier again.

**Where / rollback:** `surface-scanner/index.ts:450` only — no schema change, no trading-path logic, no cron change. Deploy with `SUPABASE_ACCESS_TOKEN_KTA` per `CLAUDE.md`; rollback = redeploy the prior version. **Verify after:** confirm new `surface_scan_complete` rows land at `info` and that `warning`-severity 24h volume drops to ~0 (leaving the tier free for a real signal).

---

## 2026-07-08 (health check, ~04:15 UTC) — every Telegram alert sends with `parse_mode: "HTML"` (deliberately, for `<b>` headers) but **no dynamic value is ever HTML-escaped**, and `sendTelegramAlert` is fire-and-forget with **no `resp.ok` check** — so any crash/error message containing `<`, `>`, or `&` makes Telegram return **HTTP 400 "can't parse entities"** and the alert is **silently dropped with zero trace**, exactly on the crash alerts that matter most

**Status:** Logged — NOT applied (this edits a shared edge-function helper + several callers and requires redeploy → Hard Stop, awaiting go; consistent with every prior entry). **Telegram / error feed is CLEAN this run:** **zero `error`/`critical` rows in the last 24h** (latest `compliance_log` rows at 04:06 UTC are all `info`: `market_data_fetch`, `auto_trade_run`); **all 10 pg_cron jobs report `succeeded`** on their last run (verified live via `cron.job_run_details`, newest 04:07 UTC — auto-trade, market-data-fetcher, surface-scanner, auto-reflect, auto-settle all green); trade table healthy (671 settled / 85 expired / 12 filled / 0 open with NULL expiration). The inbound-webhook 401 (02:15 UTC entry) is **unchanged** — `getWebhookInfo` still shows `last_error_date` = 2026-07-04 17:23 UTC, no new attempts, so nothing regressed. This entry is **distinct from every one of the 30+ prior entries**: they concern *which* condition to detect, *when* to re-alert (cadence/dedup/escalation), aggregation correctness, RLS/data exposure, memory→EV, or cron-existence detection — **none touch the encoding/delivery integrity of the alert payload itself.** This is the first entry about the alert *channel* silently eating its own messages.

**What the code shows (verified this run):**
- `_shared/telegram.ts:19–23` — `sendTelegramAlert` does `await fetch(…sendMessage, { body: JSON.stringify({ chat_id, text: message, parse_mode: "HTML" }) }).catch(() => {})`. It sends in **HTML** mode and **never checks `resp.ok`**. A Telegram `parse_mode` failure returns an HTTP **400** — a *successful* fetch at the network layer — so the `.catch(() => {})` never fires; the 400 body is discarded and the function returns as if the alert was delivered.
- **Zero HTML-escaping exists** anywhere in `_shared/` or the callers (`grep` for `escapeHtml`/`&amp;`/`&lt;` → no matches). Yet **12 files** call the alert helpers, and the alert bodies interpolate **raw** dynamic strings directly beside the intentional `<b>` tags: `auto-trade/index.ts:845` (`"${strategy.name}" … Last error: ${errMsg.slice(0,150)}`), `:926` (`${errMsg.slice(0,200)}`), `:983`; `surface-scanner/index.ts:500` (`Error: ${errMsg.slice(0,300)}`); `compact-memory/index.ts:324`; `settle-signals/index.ts:183`; and `health-check/index.ts:270` (`${recentErrors[0].message.slice(0,80)}`).
- **The failure mode is concentrated exactly where it hurts most.** The unescaped interpolations are the **CRASH / halt / error** alerts, and error strings are the strings *most* likely to contain `<`, `>`, or `&` — stack traces (`expected <X> got <Y>`), HTML error pages (`SendGrid 400: <html>…`), URLs with query params (`…&param=…`), JSON fragments. So the alert that says "surface-scanner CRASHED" or "Auto-Trade Crashed: <err>" is precisely the one that 400s and vanishes. During the Jul 5–6 error storm, any error message carrying one of these three characters would have been silently swallowed — no delivery, no log, no trace.

**Why it matters ($ / operability):** the entire hourly health-check regime — every prior entry in this log — is predicated on Telegram alerts actually *arriving*. A delivery channel that silently drops its highest-severity messages when the payload contains three extremely common characters is a **single point of silent failure under the whole monitoring stack**. It's the worst class of bug for an auto-trading system the operator runs from his phone: the alert doesn't error loudly, it evaporates, so the operator's mental model is "no alert = healthy" when the truth may be "crashed, but the crash text had a `<` in it." Severity **Medium–High** on operability (Low direct-$ today — paper mode, and *most* error strings happen not to contain these chars, which is exactly why it hasn't been noticed): a live, latent, 100%-silent drop path on the crash alerts, defeating the observability layer precisely when it's needed.

**The one improvement (ready to apply, awaiting go):**
1. **Escape every dynamic value, keep the static `<b>` templates.** Add a tiny `esc(s: string)` helper to `_shared/telegram.ts` (`s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")`) and wrap every interpolated dynamic value at the call sites (`esc(errMsg.slice(...))`, `esc(strategy.name)`, `esc(e.message.slice(...))`, etc.). Escaping only the dynamic parts preserves the intended bold headers while making the payload always-parseable. (Alternative, blunter: drop `parse_mode` entirely — but that loses the `<b>` headers 12 callers rely on, so escaping is the right fix.)
2. **Make the channel fail loud instead of silent.** In `sendTelegramAlert`, check `resp.ok`; on a non-2xx, read the body and `console.error` it (and, where a supabase client is in scope, write one `severity:'warning'` `telegram_send_failed` row to `compliance_log`) so a future encoding/delivery failure self-reports instead of evaporating. This is the guard that turns the entire class from "silent" into "visible."
3. **Guardrail:** a unit test over `esc()` asserting `<`, `>`, `&` round-trip to entities, plus one test that feeds a crash message containing all three through the alert formatter and asserts the outgoing `text` has no bare `<`/`>` outside the known `<b></b>` template — locks in that a raw dynamic value can't reach Telegram unescaped again.

**Where / rollback:** `_shared/telegram.ts` (add `esc` + `resp.ok` check) and the ~7 interpolating call sites listed above — no schema change, no trading-path logic touch, no cron change. Deploy the affected functions with `SUPABASE_ACCESS_TOKEN_KTA` per `CLAUDE.md`; rollback = redeploy the prior versions. **Verify after:** fire a synthetic alert whose body contains `a < b & c > d` and confirm (a) it now arrives in Telegram intact, and (b) with the `resp.ok` guard, a deliberately malformed send writes a `telegram_send_failed` row instead of disappearing.

---

## 2026-07-08 (health check, ~02:15 UTC) — the bot's entire **inbound** command surface (`/status`, `/health`, `/run auto-trade`, `/429`) is dead: Telegram delivers every command but Supabase's platform JWT gate returns **401 Unauthorized** before the function code runs, because the webhook authenticates via a `?secret=` query param the function checks itself — and `config.toml` never sets `verify_jwt = false` for it (`/status`, `/health`, `/run auto-trade`, `/429`) is dead: Telegram delivers every command but Supabase's platform JWT gate returns **401 Unauthorized** before the function code runs, because the webhook authenticates via a `?secret=` query param the function checks itself — and `config.toml` never sets `verify_jwt = false` for it

**Status:** Logged — NOT applied (the fix is a config change + redeploy of a production edge function → Hard Stop, awaiting go; consistent with every prior entry). **Telegram / error feed is CLEAN this run:** **zero `error`/`critical` rows in the last 24h** (nothing since the `2026-07-06 10:07:04 UTC` boundary row that closed the Jul 5–6 storm); `health_check_run` logs **"all clear"** hourly through 02:10 UTC; `market-data-fetcher` reports 18/18 series OK at 02:11 UTC. Note the *outbound* alert path is fully healthy — this entry is strictly about the **inbound** control path. This entry is **distinct from every prior entry**, and it **corrects** the 01:40 UTC entry's incidental claim that "the bot has no webhook (`getWebhookInfo` → empty url)": that check was run against the wrong bot (the shared OMII `TELEGRAM_BOT_TOKEN`); the TradeAgent bot is `@KalshiTradeAgentBot` (`TRADE_TELEGRAM_BOT_TOKEN`), and a live `getWebhookInfo` against it this run shows a webhook **is** registered and **actively erroring**. No prior entry (outbound alert cadence/dedup, DB security, trading correctness, observability cost) touches the inbound command interface.

**What the live check + code show (verified this run):**
- `getWebhookInfo` for `@KalshiTradeAgentBot` returns a registered `url` = `https://uyfnezxmgwitpzsrnkst.supabase.co/functions/v1/telegram-webhook?secret=…` with `last_error_message: "Wrong response from the webhook: 401 Unauthorized"` and `last_error_date` = **2026-07-04 17:23:29 UTC** (the last time a command was sent, it 401'd). `pending_update_count: 0` — Telegram isn't queuing because it gets a hard 401 each attempt.
- `telegram-webhook/index.ts` authenticates the request **itself**: it reads `?secret=` (`:53`) and rejects on mismatch against `TELEGRAM_WEBHOOK_SECRET` (`:51–54`). That check is the intended auth boundary — and it **never runs**, because Supabase's function gateway verifies a JWT first.
- `supabase/config.toml` has **no `[functions.telegram-webhook]` block** and therefore no `verify_jwt = false`. With the default (`verify_jwt = true`), the platform requires an `Authorization: Bearer <supabase-jwt>` header on every call. Telegram's webhook POST carries **only** the `?secret=` query param — no such header — so the gateway returns 401 *before dispatching to the function body*. The function's own secret validation is dead code in production.
- Net: every `/status`, `/health`, `/429`, `/run mdf`, `/run auto-trade` Onofre texts the bot is silently rejected at the gate. The commands *look* implemented (full handler at `:83–200`) but have never been reachable since the webhook was pointed at a JWT-verified function.

**Why it matters ($ / operability):** this is the operator's **only two-way lever** on a system that auto-trades on a schedule — `/run auto-trade` to force a cycle, `/status`/`/health` to check state, `/429` to inspect rate-limit stalls, all from the phone without opening a laptop. During the Jul 5–6 error storm that exact remote-control surface would have been the fastest way to triage, and it was silently inert. Low direct-$ (paper mode, outbound alerting still works so nothing is *unmonitored*), but it defeats a built, deployed feature and removes the fast-triage path precisely when it's most needed. Severity **Low–Medium**: no data/security exposure (the JWT gate is *over*-restrictive here, not under-), purely a broken control channel — but a 100%-dead one, actively erroring for days, that the operator likely believes works.

**The one improvement (ready to apply, awaiting go) — config + redeploy, no code change:**
1. **Disable the platform JWT gate for this one function so its own `?secret=` check becomes the auth boundary.** Add to `supabase/config.toml`:
   ```toml
   [functions.telegram-webhook]
   verify_jwt = false
   ```
   then redeploy: `source ~/.omii_env && SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA npx supabase functions deploy telegram-webhook --no-verify-jwt --project-ref uyfnezxmgwitpzsrnkst`. This does **not** open a hole — the function already enforces `?secret=` (`:51–54`) and `TELEGRAM_WEBHOOK_SECRET` is unguessable; disabling JWT simply lets that intended check run. This is the standard Supabase pattern for provider webhooks (Stripe/Telegram) that can't send a Supabase JWT — the sibling `stripe-webhook` needs the same treatment; confirm it isn't 401'ing too as a follow-up.
2. **Guard:** after redeploy, `getWebhookInfo` should show an empty `last_error_message`; send `/status` and confirm a reply. Optionally add a health-check probe that pings `getWebhookInfo` and pages if `last_error_message` is non-empty for >6h, so a re-broken webhook self-reports instead of staying silently dead.

**Where / rollback:** `supabase/config.toml` (+ redeploy of `telegram-webhook`) only — no schema change, no trading-path touch, no other function. Rollback = redeploy without `--no-verify-jwt` (restores the current, already-broken-but-safe state). **Verify after:** `getWebhookInfo` clean + a live `/status` round-trips a reply from `@KalshiTradeAgentBot`.

---

## 2026-07-08 (health check, ~01:45 UTC) — health-check's win-rate-collapse alarm **pools every strategy together and throws away the `strategy_id` it already fetches**, so one failing strategy is masked by profitable ones and, when it does page, can't name which strategy broke

**Status:** Logged — NOT applied (this edits a production edge function → deploy is a Hard Stop, awaiting go; consistent with every prior entry). **Telegram / error feed is CLEAN this run:** **zero `error`/`critical` rows since `2026-07-06 10:07:04 UTC`** (~40h) — the whole Jul 5–6 storm is resolved: the systemic `.catch()`-on-builder crashes stopped, and the orphaned `lesson_write_error` trade `2ae0d30e…` **backfilled its lesson** (`trade_lessons` id `483146cc…`, `stale_signal`, written `2026-07-06 10:30:34 UTC`) — that loose end from the Jul 6 entry is now closed. `health_check_run` logs **"all clear"** hourly through 01:10 UTC. This entry is **distinct from every prior entry**: neighbors cover DB security (RLS/anon grants), the `.catch()` builder bug, lesson_type drift + orphan re-page, bracket-sum false positives, and observability cost (indexes, severity noise, cadence). **None touch the *correctness* of an alarm's aggregation** — this is the first entry about the watchdog computing the *wrong number*.

**What the code shows (verified, `supabase/functions/health-check/index.ts`):**
- §2 win-rate-collapse fetches `pnl, strategy_id` for the newest 20 settled trades (`:131–137`) — **it selects `strategy_id`** — then at `:140–142` computes `wins = pnl>0` over the **entire pooled sample** and evaluates the 60% floor once, globally. `strategy_id` is fetched and **never referenced**. The alert message (`:152`) likewise can't say which strategy is failing because it never grouped.
- **Consequence — dilution masks a real collapse:** a losing strategy is averaged against profitable ones. Concretely, live right now the pooled window is **16W/4L = 80%** (well above the 60% floor); an S-005 running at, say, 3W/7L (30%) would be fully hidden as long as another strategy's wins keep the *pool* ≥60%. The alarm meant to catch a broken strategy is structurally blind to a single-strategy break — the exact failure it exists to catch.
- **Second axis — multi-tenant pooling:** the same query has **no `user_id` scope**, so the global newest-20 window is shared across all users. Benign today (effectively one paper user), but the product thesis is onboarding many users into the community flywheel — the moment a second active trader exists, the 20-trade window is dominated by whoever trades most and the floor check becomes meaningless per-user. (§1 silence and §3 volume-spike share this global-pool property, but for an *operator* "did the whole system stop / run away" signal that's arguably correct; win-rate is the one check that is inherently a per-strategy/per-user *quality* signal and is therefore wrong when pooled.)

**Why it matters ($ / track record):** per-strategy win rate **is** the artifact — the paper track record that gates the uncle-capital unlock and the public performance page is only meaningful strategy-by-strategy. A watchdog that can't detect (or name) a single strategy decaying below the floor means capital and confidence keep flowing to a losing strategy while the pooled number reads healthy — a silent, directly-financial blind spot, and a false *sense* of monitoring, which is worse than none. Severity **Medium**: latent while win rate is high and users are one, but it defeats the stated purpose of the alarm and degrades further with every new user/strategy.

**The one improvement (ready to apply, awaiting go):**
1. **Group by the `strategy_id` it already selects.** Bucket `recentSettled` per `strategy_id`, apply the ≥10-sample guard and the 60% floor **per strategy**, and fire one alert per collapsed strategy naming it: e.g. `🔴 [TradeAgent] "Weather Edge" win rate 30% (3W/7L of 10) — floor 60%`. Fingerprint per strategy so each collapses/re-alerts independently.
2. **Scope per `user_id`** (add `strategy_id` **and** `user_id` to the group key) so the check stays correct as the community flywheel onboards traders; keep the operator-level global checks (silence, cron, volume-spike) as-is.
3. **Guardrail:** a tiny unit test over §2 with a synthetic mix (one 80% strategy + one 30% strategy in the same window) asserting the 30% strategy pages — locks in that dilution can't silently return.

**Where / rollback:** `supabase/functions/health-check/index.ts` §2 (`:130–155`) only — no schema change, no other function, no trading-path touch. Deploy with `SUPABASE_ACCESS_TOKEN_KTA` per `CLAUDE.md`; rollback = redeploy the prior function. **Verify after:** seed a synthetic sub-floor strategy in a scratch check (or backtest window) and confirm health-check emits a per-strategy alert naming it, while the healthy strategy stays silent; confirm no change to the "all clear" path when every strategy is ≥60%.

---

## 2026-07-08 (health check, ~01:40 UTC) — `weather_bucket_calibration` is the **only public table with RLS disabled**, yet it grants the public `anon` role full `INSERT/UPDATE/DELETE/TRUNCATE` — so anyone holding the frontend's publishable anon key can read, poison, or wipe the S-005 weather-calibration table straight through the PostgREST REST endpoint, with no policy backstop

**Status:** Logged — NOT applied (this changes production DB security config, so it awaits an explicit go — consistent with every prior entry). **Telegram / error feed is CLEAN this run:** exactly **zero `error`/`critical` rows since `2026-07-06 10:07:04 UTC`** (~39h — that boundary row is the *last* `lesson_write_error` of the resolved Jul 5–6 storm); all **10 pg_cron jobs** report `last_status='succeeded'`, `is_stale=false`, `last_run_failed=false` (verified live via `agent_cron_health`, 01:34 UTC — auto-settle, surface-scanner, market-data-fetcher all ran within the last 5 min); no stale `auto_trade_locks`; the bot has no webhook (`getWebhookInfo` → empty url), so the feed is one-way alert-out with nothing errored to page. This entry is **distinct from every prior entry**: none touch **row-level security, table grants, or PostgREST/anon-key exposure** — the neighbors concern P&L/track-record integrity (memory attribution, paper fills, force-expire pnl:0), the learning-loop write path (lesson_type drift, orphan re-page), scanner signal correctness (bracket-sum false positives), and observability substrate cost (compliance_log indexes, severity noise, alert cadence). This is the first entry about a **live multi-tenant data-exposure hole**.

**What the data shows (verified live this run):**
- Across all 31 public tables, **exactly one has RLS off**: `pg_class.relrowsecurity = false` for `weather_bucket_calibration` (0 policies). Every other user-data table has RLS **enabled** — including its own siblings `weather_calibration` (RLS on, 0 policies → default-deny) and `weather_forecasts` (RLS on, 2 policies).
- **The grants make the gap live, not theoretical:** `information_schema.role_table_grants` shows the `anon` **and** `authenticated` roles both hold `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` on the table. The sibling tables grant the *same* broad privileges to anon — but there RLS filters every row, so the grants are inert. Here, with RLS off, PostgREST exposes the table at `/rest/v1/weather_bucket_calibration` and the anon grants execute **unfiltered**. The anon/publishable key ships in the deployed frontend bundle by definition, so the reachability bar is "view source."
- **The only legitimate writer is the service role, which bypasses RLS:** `auto-settle/index.ts:265` upserts the per-trade S-005 calibration outcome using a client built with `SUPABASE_SERVICE_ROLE_KEY` (`auto-settle/index.ts:58,65`). So enabling RLS cannot break the writer — the service role ignores RLS entirely. This is exactly how the sibling `weather_calibration` is already configured (RLS on, no policies, service-role writer).

**Why it matters ($ / integrity, honestly scoped):** this is **not** a PII or key breach — the sensitive material (encrypted Kalshi + AI-provider keys in `api_keys`, user `trades`, `profiles`) all sits behind enabled RLS. The exposure is **integrity and availability of the weather strategy's calibration feedback**: `weather_bucket_calibration` is the outcome ledger S-005 uses to calibrate weather-bucket probabilities, so any anon-key holder can (a) **TRUNCATE/DELETE** it to erase the strategy's learned calibration, or (b) **INSERT/UPDATE** fabricated `yes_resolved`/`pnl` rows to *poison* it — steering S-005 toward attacker-chosen bets. For a product whose entire thesis is a *trustworthy, improving* paper track record gating the uncle-capital unlock, a world-writable calibration table is a direct, silent hole in the learning loop (no error, no alert — a poisoned row looks identical to a real settlement). Severity is **Medium**, not Critical — low data sensitivity, but a live, unauthenticated write/delete path and the single RLS gap in an otherwise fully-covered schema, i.e. exactly the class Supabase's own security advisor flags as *"RLS Disabled in Public."*

**The one improvement (ready to apply, awaiting go) — one line, zero functional impact:**
1. **Enable RLS (minimum, closes the hole):** `ALTER TABLE public.weather_bucket_calibration ENABLE ROW LEVEL SECURITY;` — with no policies this is default-deny to anon/authenticated while the service-role writer (`auto-settle`) continues unchanged. Mirrors the already-correct `weather_calibration` config exactly.
2. **Revoke the broad anon grants (defense-in-depth):** `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.weather_bucket_calibration FROM anon, authenticated;` so the exposure can't reappear if RLS is ever toggled off again. (Optional but cheap; the frontend never needs to write this table.)
3. **Guardrail (make the class impossible to recur):** add a one-line CI/health assertion that queries `pg_class` for any `public` table with `relrowsecurity = false` and fails loud — the same "fail on drift" pattern already proposed for the lesson_type enum. One RLS-off table slipped through; a check ensures the next one can't.

**Where / rollback:** one migration applied via the management API with `$SUPABASE_ACCESS_TOKEN_KTA` per `CLAUDE.md` (never `supabase db push`) — no edge-function redeploy, no schema change to columns, no trading-path touch. Rollback: `ALTER TABLE … DISABLE ROW LEVEL SECURITY;` (and re-`GRANT` if step 2 applied) — fully reversible in one statement. **Verify after:** with the project's anon key, `curl` `GET` then `DELETE` on `/rest/v1/weather_bucket_calibration` and confirm it returns rows/deletes *before* and is denied (empty / 401-403) *after*; then run `auto-settle` once and confirm it still upserts the S-005 calibration row (service role unaffected); finally re-query `pg_class` and confirm zero `public` tables with `relrowsecurity=false`.

## 2026-07-07 (health check, ~21:12 UTC) — The **moat is currently net-negative and nobody would know**: trades whose decision was influenced by injected `agent_memory` (`influenced_by_memory_ids` populated) lose money and win less often than un-influenced trades — and the memory quarantine gate keys on **confidence (win rate), not realized P&L**, so a memory that raises win-rate while destroying expected value survives the self-correction loop indefinitely

**Status:** Logged — NOT applied (analysis + measurement only this run; no code change or deploy). This changes what the memory feedback loop optimizes for, so it awaits an explicit go. **Telegram / error feed is CLEAN this run:** the last 24h shows **zero `error`/`critical` rows** — the Jul 5–6 storm (93 `.catch`-on-builder strategy crashes + 80 `lesson_write_error` check-constraint rejections) stopped at `2026-07-06 10:07 UTC` and has not recurred; `order_filled` is healthy (8 fills Jul 6, 6 Jul 7), so the agent is trading normally. This entry is **distinct from every prior entry**: no prior entry measures memory→P&L attribution or the confidence-vs-EV gap. The neighbors touch *whether a lesson gets written* (lesson_type drift, orphan-write give-up) and *whether the fill is realistic* (paper liquidity, force-expire pnl:0) — none ask whether the memory layer, once wired, actually **makes money**.

**What the data shows (queried this run, settled+expired, last 60d):**
- **Un-influenced** trades: n=526, win rate **73.2%**, avg P&L **+1.80**, total **+$947.18**.
- **Memory-influenced** trades: n=46, win rate **45.7%**, avg P&L **−1.47**, total **−$67.56**.
- **Confound-controlled** (all 46 influenced trades are S-005, so compare S-005 to itself): S-005 *with* memory → WR **46%**, P&L **−$67.56**; S-005 *without* memory → WR **38%**, P&L **+$306.23**. So memory injection raises S-005's win rate (+8 pts) while flipping its P&L from strongly positive to negative — the signature of **winning more often but losing far more per loss** (bigger size / worse risk-reward on the assisted bets).
- Attribution is surfaced **nowhere**: `influenced_by_memory_ids` is written by `execute-trade` but no analytics view computes P&L-by-memory-influence (`ObservabilityPage.tsx` shows per-memory confidence/quarantine state, not portfolio-level memory P&L).

**Why the quarantine gate misses it:** a memory is quarantined when its "exposed confidence drops below 0.30 after 10+ attributed trades" (`ObservabilityPage.tsx:281`) — confidence tracks **win rate**, not dollars. A memory that steers toward trades that win 46% of the time but lose −$67 net has an *above-threshold* win rate and is never quarantined, even though it is destroying expected value. The self-correction system is optimizing the wrong objective.

**Why it matters ($ / the moat):** `CLAUDE.md` states the moat is "the compounding collective intelligence… not the code," and that the uncle's ~$50k unlock gates on a real paper track record. Right now the data says the compounding-intelligence layer is **subtracting** value on the one strategy it touches. That is the single most important fact about the product thesis, and it is currently invisible. Caveat, stated honestly: n=46 is small and not statistically conclusive — a −27pt win-rate gap and negative total could still be partly noise or a confound not captured here. But the point is not the p-value; it is that **there is no instrument that would ever surface this**, so a moat that is silently value-negative could persist indefinitely while the narrative assumes it compounds.

**The one improvement (ready to build, awaiting go) — make the memory loop optimize P&L, and measure it:**
1. **Measure first (cheap, non-invasive):** add a memory-attribution panel/query — realized P&L and win rate for memory-influenced vs un-influenced trades, sliced by strategy and by individual memory ID. This alone converts an invisible risk into a monitored one; no behavior change.
2. **Fix the gate:** extend the quarantine criterion from confidence-only to include **realized P&L per attributed trade** — quarantine (or down-weight) a memory whose attributed trades have negative expected value even if their win rate is acceptable.
3. **Guardrail:** until a memory has a positive attributed-P&L record over a minimum sample, inject it as *observability context only* (as win-streak already is) rather than as a decision input, so an unproven lesson can't move real size.

**Where / rollback:** measurement is read-only (new query + a panel in `ObservabilityPage.tsx`); the gate change lives in the memory feedback path (`auto-reflect` / confidence-decay + quarantine logic) and is a pure scoring change — reversible by reverting the function, no schema migration required. **Verify after:** re-run the memory-influenced vs un-influenced P&L split weekly and confirm the gap closes (or that value-negative memories now get quarantined/demoted), and confirm the panel renders the two cohorts with live numbers.

## 2026-07-07 (health check, ~20:20 UTC) — Paper fills are **idealized**: the paper path in `execute-trade` books the full size instantly at the exact quoted price and **skips the `checkLiquidity` step entirely** (it runs only on the live path, after the paper block has already returned) — so the paper track record assumes infinite depth and zero slippage, systematically overstating what live execution would actually achieve

**Status:** Logged — NOT applied (no code change or deploy this run; this touches the execution write path and the meaning of every paper P&L number, so it awaits an explicit go). **Telegram / error feed is CLEAN this run:** exactly **zero `error`/`critical` rows since `2026-07-06 10:07:04 UTC`** (~34h — that boundary row is the *last* `lesson_write_error` of the Jul 5–6 storm, both root causes of which were fixed 07-06 via `20260706_trade_lessons_lesson_type_expand.sql` + the `.catch`-on-builder cleanup); latest `health_check_run` = **"all clear" (20:10 UTC)**, `market-data-fetcher` = **18/18 series OK**, `auto-trade` = **0 errors**. This entry is **distinct from every prior entry**: the closest neighbor (`~05:12 UTC`) concerns auto-settle booking force-expired *exits* at `pnl: 0` — an **exit/settlement** realism bug. This is the **entry/fill** realism bug: the price and size a position is *opened* at, before it ever settles. No prior entry touches `checkLiquidity`, slippage, or partial fills.

**What the code shows (`supabase/functions/execute-trade/index.ts`, read this run):**
- The paper block (`~:359–420`) inserts the trade with `status: "filled"`, `filled_price: price`, `filled_at: now`, `amount` = full requested size — **the exact quote, the full quantity, instantly** — then returns.
- `checkLiquidity(...)` (defined `:67`, called `:464`) — which on the live path detects thin books, splits oversized orders (`partial_fill_then_limit`), and falls back to a limit order when there's no depth on the requested side — is **never reached for paper trades** because the paper branch returns ~44 lines earlier.
- Net effect: a paper order to buy 100 contracts of a NO leg @ 89¢ fills 100 @ 89¢ every time, even if the live book shows 12 contracts @ 89¢ and the rest 3–6¢ worse. The S-001 surface-arb baskets (which fire multi-leg, e.g. the 20:05 UTC `3 legs filled @ 89c`) are the most exposed: an arb's entire edge lives in the *combined entry cost*, and idealized per-leg fills can manufacture an arb on paper that the live book would never have let you assemble at those prices.

**Why it matters ($ / the moat):** this project's `CLAUDE.md` is explicit that the moat is **not the code — it's a trustworthy, improving paper track record**, and that record is the exact artifact gating the uncle's ~$50k family capital ("a real paper-trading track record, not a pitch," against "a concrete pre-agreed performance bar"). An entry-fill model that assumes infinite liquidity makes that record **optimistic in a way that does not survive contact with real order books** — precisely the failure that converts a paper winner into a live loser and burns the most sensitive money in the plan on the first live trade. It also silently poisons the learning loop: every lesson reflected from a too-good paper fill teaches `agent_memory` an edge that isn't real. Per the same file's rule — *never state or imply the agent is profitable* — a fill model that inflates paper P&L is a direct threat to the one number the whole thesis rests on.

**The one improvement (ready to apply, awaiting go) — make paper fills respect the book:**
1. **Minimum (fail-honest):** run the existing `checkLiquidity` in the paper path too, and when depth is insufficient, book the *same* partial-fill / worse-price outcome the live path would get, instead of a full fill at quote. Reuses code that already exists — no new modeling.
2. **Better (slippage model):** fill each leg by walking the displayed order book (`yes_ask`/`no_ask` levels already fetched for the liquidity check), so `filled_price` reflects the volume-weighted cost of the requested size and the fill can come back partial — with a conservative default haircut when depth data is missing.
3. **Guardrail:** flag or reject any paper *arbitrage* basket whose edge only exists under the idealized fill (recompute the basket's combined cost at book-walked prices before marking it `filled`), so S-001 can't log paper arbs that live execution couldn't have assembled.

**Where / rollback:** all in `execute-trade/index.ts` — move/duplicate the `checkLiquidity` call (`:464`) above the paper branch (`:359`) and thread its result into the paper insert's `filled_price`/`amount`/`status`; deploy `execute-trade` only (`SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA npx supabase functions deploy execute-trade --project-ref uyfnezxmgwitpzsrnkst`). Rollback: revert the one function, redeploy — no schema change, no migration, fully reversible. **Verify after:** place a paper order larger than a known-thin market's displayed depth and confirm it now books a partial fill / worse VWAP and emits a `liquidity_fallback` row, while a paper order inside available depth still fills full at quote unchanged.

## 2026-07-07 (health check, ~18:15 UTC) — The `trade_lessons.lesson_type` allowlist is maintained as **two hand-synced copies** — the `validLessonTypes` array in `auto-reflect/index.ts:458` and the `trade_lessons_lesson_type_check` DB constraint — with **no guard forcing them to agree**; they already drifted once (code ahead of DB) and silently dropped 12+ lessons before the 07-06 migration realigned them, and nothing prevents the exact same drift from recurring on the next added type

**Status:** Logged — NOT applied (no code, migration, or deploy this run; the fix touches the learning-loop write path, so it awaits an explicit go). **Telegram / error feed is CLEAN this run:** exactly **zero `error`/`critical` rows since `2026-07-06 10:07:04 UTC`** (~32h — that boundary row is the *last* `lesson_write_error` of the original storm, not a new one); all **10 pg_cron jobs** report `last_status = succeeded`, `is_stale = false`, `last_run_failed = false` (verified live via `agent_cron_health`, 18:13 UTC); bot has **no webhook** (`getWebhookInfo` → empty url), so the feed is one-way alert-out with nothing errored to page. This entry is **distinct from every prior entry**: those concern the surface-scanner's arb-detection correctness, `compliance_log` storage/index debt, the tenant-suffix kill switch, `warning`-tier noise, alert cadence/backoff, and daily-loss breakers. **None address the *structural drift hazard* between the code's lesson-type allowlist and the DB constraint** — every prior mention of `lesson_type` treats the 07-06 storm as *resolved*, not as a class of failure that can silently return.

**What the data shows (verified live + in code):**
- The original storm was real and lossy: **20 `lesson_write_error` / 23514 check-violation rows** across `2026-07-05 15:07 → 2026-07-06 10:07`, each one a *lesson that was computed by the LLM and then thrown away* — e.g. `KXHIGHNY-26JUL02-B99.5`, lesson_type `stale_signal`, `"violates check constraint trade_lessons_lesson_type_check"`. The reflection ran, spent the LLM call, produced the insight, and the DB rejected the insert.
- **Root cause is a two-copy allowlist that drifted:** `auto-reflect/index.ts:458` hard-codes `validLessonTypes = ["forecast_bias","market_timing","stale_signal","kelly_mismatch","signal_quality","execution","market_structure","general"]`, and `:554` coerces *LLM* output to `"general"` if it's not in that array. But that coercion only guards against the model hallucinating a type — it does **nothing** when `validLessonTypes` itself contains a value (`stale_signal`, `kelly_mismatch`) that the **DB CHECK constraint does not yet allow**. The code happily passed `stale_signal`; the DB rejected it. Code was ahead of schema.
- **The 07-06 migration realigned them but institutionalized the hazard:** `20260706_trade_lessons_lesson_type_expand.sql` expanded the constraint to the same 8 values and its own comment states the process — *"validLessonTypes in auto-reflect/index.ts is the single source of truth. When adding a new lesson type there, add it here too."* That is a **manual, two-place, easily-forgotten sync** — the precise setup that just failed. I verified the two lists are byte-for-byte aligned **right now** (8 values each, identical set), so there is no active error — but the next engineer who adds a 9th type to `:458` and forgets the migration reintroduces the identical silent-loss storm, and it will again fail *after* the LLM spend, invisibly, until a health check catches it.

**Why it matters ($ / the moat):** per `CLAUDE.md`, the product's moat is explicitly the **compounding learning loop** — "the compounding collective intelligence that a solo operator or closed-source competitor cannot replicate," built on `agent_memory` and the per-trade lesson pipeline. A silent drop of `trade_lessons` inserts is a direct hole *in the moat itself*: lessons are computed (LLM cost paid) and then lost, so the agent stops learning from exactly the trades it just reflected on — and it fails invisibly (the trade still settles, the dashboard looks fine). For a system whose entire thesis and family-capital unlock rest on a *trustworthy, improving* track record, a learning loop that can silently stop learning on a one-line code edit is a latent integrity bug, not a cosmetic one. It is strictly cheaper to make drift impossible now than to re-detect it via the next storm.

**The one improvement (ready to apply, awaiting go) — make the two copies unable to disagree:**
1. **Fail loud on drift (minimum):** add a lightweight test/CI assertion (there is already a `_shared/*.test.ts` suite) that reads the live `trade_lessons_lesson_type_check` allowed array and asserts it **equals** `validLessonTypes` exactly — so a code/DB mismatch fails the build instead of silently dropping lessons in production.
2. **Or eliminate the second copy (better):** drop the hard `CHECK` and enforce the allowlist in one place — either a `BEFORE INSERT` trigger that coerces an unknown `lesson_type` to `'general'` (fail-soft: the lesson body is *never* lost, only its label degrades), or a FK to a small `lesson_types` reference table that both code and constraint read from. Single source of truth, no manual sync step.
3. **Defense-in-depth at the write site:** on a `lesson_type` check-violation specifically, retry the insert once with `lesson_type = 'general'` before logging `lesson_write_error`, so even an un-migrated new type preserves the lesson content rather than discarding it.

**Where / rollback:** option 1 is test-only (no deploy, no schema touch) — the safest first step; option 2/3 touch `auto-reflect/index.ts` (`:458`, `:554`, insert block `:630-653`) plus one migration for the trigger/reference table, applied via the management API with `$SUPABASE_ACCESS_TOKEN_KTA` per `CLAUDE.md` (never `supabase db push`), redeploy `auto-reflect` only. Rollback: revert the test / drop the trigger / restore the hard `CHECK`. **Verify after:** add a deliberately-unlisted `lesson_type` in a scratch test and confirm the write path either (a) fails CI (option 1) or (b) still inserts the lesson with `lesson_type='general'` and emits **zero** `lesson_write_error` (option 2/3); then confirm normal reflection still writes `stale_signal`/`signal_quality` lessons unchanged.

---

## 2026-07-07 (health check, ~17:10 UTC) — The `bracket_sum_violation` detector treats **every market under an event ticker as one MECE set that must sum to ~100¢**, but Kalshi events mix mutually-exclusive range brackets (`-B…`) with **nested cumulative threshold markets (`-T…`, "above X")** whose YES prices legitimately sum far above 100¢ — so the scanner emits a flood of false-positive "arbitrage" alerts: **168 `bracket_sum_violation` rows in the last 24h, only 2 exploited (1.2%)**

**Status:** Logged — NOT applied (no code change or deploy this run; this touches `surface-scanner` logic and the S-001 signal path, so it awaits an explicit go). **Telegram / error feed is CLEAN this run:** all 10 pg_cron jobs report `last_status = succeeded`, `is_stale = false`, `last_run_failed = false` (verified live via `agent_cron_health` at 17:07 UTC); no webhook is set on the bot (`getWebhookInfo` → empty url, 0 pending), so the feed is one-way alert-out and there is nothing errored to page. This entry is **distinct from every prior entry**: those concern `compliance_log` storage/index debt, the per-strategy kill switch keyed to stale IDs, alert cadence/backoff, and daily-loss breakers. **None touch the *correctness of the surface-scanner's arbitrage detection itself*** — the signal that S-001 (`KXINX/KXBTC/KXETH surface arb`) is built to trade.

**What the data shows (verified live):**
- `surface_scanner/index.ts:213-258` groups markets by `event_ticker` only, with the sole gate `if (group.length < 3) continue` (`:214`), then `const sumYesCents = group.reduce((s, m) => s + m.mid_cents, 0)` (`:216`) and flags **overpricing** when `sumYesCents > 115` (`:241`). There is **no filter on market type** — every market under the event is summed as if the set partitions probability space.
- **This is false for threshold (`-T`) ladders.** `KXCPI-26JUL` (flagged this run: "4 markets sum to 288¢ — exceeds 100¢ by 188¢") contains **only threshold markets**: `KXCPI-26JUL-T-0.4 … -T0.5` (verified in `kalshi_markets_cache`). "Above 0.2%" ⊇ "above 0.4%", so these are **nested, not mutually exclusive** — their YES prices are *supposed* to sum well above 100¢. Flagging that as arbitrage is a category error.
- The largest alerts this run — `KXBTC-26JUL0714` (98 markets → 4445¢), `KXETH-26JUL0714` (73 → 3596¢) — are the same failure mode at scale: strike ladders that don't form a single clean 100¢ partition being summed wholesale.
- **Volume proves it's noise, not signal:** `select count(*), count(*) filter (where is_exploited)` on `surface_alerts where alert_type='bracket_sum_violation' and created_at > now()-interval '24h'` → **168 total, 2 exploited**. A 98.8% never-acted-on rate is the signature of a detector firing on non-actionable inputs.

**Why it matters ($ / signal integrity):** S-001's entire thesis is exploiting bracket-sum violations, and this detector is its eyes. In paper mode the cost today is noise — a polluted `surface_alerts` table and (per the prior kill-switch entry) a mostly-inert S-001. But the moment S-001 trades: (a) a `-T` threshold "overpricing" alert says *sell YES / buy NO across the ladder*, which on nested thresholds is **not** a hedged arb — it's an unhedged directional bet dressed up as free money, a direct path to real losses; and (b) 166 daily false positives bury the handful of genuine `-B` range-bracket violations that *are* tradeable, degrading the one edge the strategy is supposed to have. A risk-managed track record — the whole product thesis and the family-capital unlock — cannot rest on a signal that is 98.8% false.

**The one improvement (ready to scope, awaiting go) — scanner logic only, no trading-execution change:**
1. **Restrict the MECE sum to genuine range brackets.** Only sum markets that actually partition the outcome space — Kalshi range brackets (`-B…` / `-BxxxxTyyyy` two-sided buckets) within a single strike ladder — and **exclude `-T` "above/below threshold" markets**, which are nested and belong to the `monotonicity_violation` check (already handled separately at `:153-197`). Parse the ticker suffix / market subtype to classify before summing.
2. **Sub-group by ladder, not by bare event.** Where an event carries multiple ladders, key the group by the full bracket series so 98 unrelated strikes aren't summed into one 4445¢ figure.
3. **Add a sanity guard:** if `group.length` is large and `sumYesCents` is a multiple of ~100¢ (e.g. > 300¢ across many markets), that is a grouping bug, not an arb — suppress and log rather than alert.

**Where / rollback:** single edge-function change in `supabase/functions/surface-scanner/index.ts` (the `checkBracketSums` MECE block, ~`:197-260`); redeploy via `SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_KTA npx supabase functions deploy surface-scanner --project-ref uyfnezxmgwitpzsrnkst` per `CLAUDE.md`. No schema change, no migration, no other function touched. Rollback: redeploy the prior version. **Verify after:** run one scan and confirm `bracket_sum_violation` count drops to the genuine `-B` range-bracket cases only, that no `-T`-only event (e.g. `KXCPI-26JUL`) is flagged, and that any surviving alert points at a set whose members truly partition to ~100¢ (`explain`/manual check on 2-3 survivors).

---

## 2026-07-07 (health check, ~16:15 UTC) — `compliance_log` is an unbounded, unindexed heartbeat firehose: **276,616 rows / 153 MB, +~1,150/day since April, no retention cron and no `created_at` index** — so the hourly health-check itself sequential-scans a table that only grows, and 99.9% of it is routine `info`/`warning` telemetry, not audit signal

**Status:** Logged — NOT applied (no schema change or deploy this run). This is the one new improvement for this run and is **distinct from every prior entry**: those concern the *content* of alerts (escalation, backoff, dedup, severity tiers, kill switches, P&L correctness). This is the first to address the **storage + query cost of the observability substrate itself** — the table every health check reads. **Telegram feed is CLEAN this run:** zero `error`/`critical` rows since `2026-07-06 10:07 UTC` (~30h); the S-001 `.catch`-on-builder storm and the `lesson_type`/`trade_lessons` constraint storm are both resolved (auto-reflect redeployed v43 @ `10:29`, auto-trade v137 @ `16:49`), and every `auto_trade_run` since reports `0 errors`. Last Telegram page was `cron_failed` @ `2026-07-06 21:06`, now quiet.

**What the data shows (verified live):**
- `select count(*), pg_size_pretty(pg_total_relation_size('compliance_log'))` → **276,616 rows, 153 MB**, oldest row `2026-04-06`, newest `2026-07-07 16:12`. Growth is steady at **~1,090–1,203 rows/day** over the last 7 days.
- **No retention/pruning job exists:** `select … from cron.job where command ilike '%compliance_log%' or '%delete%' or jobname ilike '%prune/clean/retention%'` → **zero rows**. Nothing ever deletes from this table; it grows forever.
- **Composition is ~pure noise:** by severity, `info` 62.4% + `warning` 37.5% = **99.9%**; only **288 rows (0.1%)** are `error`/`critical` — the audit-relevant signal. By event_type, the top two are heartbeat events — `surface_scan_complete` (104,293) and `auto_trade_strategy_run` (103,454) = **75% of the entire table** — plus `auto_trade_run` (23,212), `market_data_fetch` (13,203), `auto_settle_run` (11,781), `weather_signal_run` (9,060). These are "a cron ran" rows with no long-term value.
- **The compounding cost — no supporting index:** `pg_indexes` for `compliance_log` shows only `compliance_log_pkey` (on `id`) and `idx_compliance_user_id` (on `user_id`). **There is no index on `created_at`, `severity`, or `event_type`.** Yet the hourly health-check filters exclusively on those columns — e.g. `health-check/index.ts:276-282` (`.in("severity",["error","critical"]).gte("created_at", twoHoursAgo)`) and the surface/alert sweeps. Every one of those queries is a **sequential scan over all 276k rows** (Postgres can't use the `user_id` index for a `created_at`/`severity` predicate), and that scan gets linearly slower every single day the table grows. Unbounded rows × no index = a monitor that degrades itself.

**Why it matters ($ / reliability):** the health-check is the whole safety net for an unattended trading agent — it must stay fast and cheap to run hourly. Today it pays a full-table seq-scan per query, on a table that will cross **~500k rows by October** at the current rate and keep climbing. That is rising Supabase storage/compute cost for **zero analytical benefit** (the signal is 0.1% of the volume), and a slowly-rotting watchdog whose own queries creep toward timeout as the fleet it monitors expands. It also makes any human forensic query on the log (the point of a compliance log) progressively more painful. This is textbook silent ops debt: nothing is broken *today*, and it is strictly cheaper to fix now at 276k rows than later at 1M+.

**The one improvement (ready to apply, awaiting go) — storage/observability only, no trading path or business-logic touch:**
1. **Add the missing indexes** so the hourly queries stop seq-scanning: a composite `create index idx_compliance_created_at on compliance_log (created_at desc)` at minimum, ideally `(severity, created_at desc)` and `(event_type, created_at desc)` to cover the health-check's actual predicates. Build `CONCURRENTLY` to avoid locking writes.
2. **Add a retention cron** (`pg_cron`, e.g. nightly): **keep `error`/`critical` forever** (or ≥1yr) — that is the audit trail; **prune routine `info`/`warning` heartbeat events** (`surface_scan_complete`, `auto_trade_strategy_run`, `auto_trade_run`, `market_data_fetch`, `auto_settle_run`, `weather_signal_run`) older than **30 days**. This alone reclaims ~75%+ of the table immediately and caps steady-state size. Delete in batches (`… where ctid in (select ctid … limit 10000)`) to avoid a long lock on the first sweep.
3. **Optional durability:** if any heartbeat history is wanted for trend analysis, roll it into a daily-aggregate table before pruning (count per event_type per day) — keeps the trend, drops the row volume.

**Where / rollback:** one new migration (`create index concurrently …` + a `pg_cron.schedule('compliance-log-retention', …)` calling a batched-delete function). No edge-function redeploy required; no trading path, no schema change to existing columns. Rollback: `drop index` + `cron.unschedule('compliance-log-retention')` — deletes of 30-day-old heartbeat rows are not recoverable, so gate the first prune behind a `select count(*)` dry-run and confirm the predicate excludes `error`/`critical` before enabling. **Verify after:** create the indexes, then `explain analyze` the health-check's `severity in (…) and created_at > now()-interval '2h'` query and confirm it now uses `idx_compliance_created_at` (Index Scan, not Seq Scan); run the retention function once and confirm row count drops ~75% while `select count(*) where severity in ('error','critical')` is **unchanged**. Apply the migration via the management API with `$SUPABASE_ACCESS_TOKEN_KTA` per `CLAUDE.md` (never `supabase db push`).

---

## 2026-07-07 (health check, ~15:12 UTC) — The per-strategy auto-halt kill switch has been silently **inert for every live strategy since the ~May 25 multi-tenant migration**: `strategy_config` is keyed by bare IDs (`S-001`) but live strategies are tenant-suffixed (`S-001-ea207ba1`), so `config` is always `undefined` and the failure-counter / auto-halt never runs

**Status:** Logged — NOT applied (no code change or deploy this run; kill-switch behavior is business-logic + touches the trading path, so it awaits an explicit go). **Telegram feed is CLEAN right now** — the `.catch is not a function` strategy-crash storm on S-001 and the `lesson_write_error` / `trade_lessons` constraint storm both stopped `2026-07-06 10:05–10:07 UTC` and every `auto_trade_run` since is `3 ran, 0 errors, 0 halted` (last verified 15:05 UTC); the health-check sweep *did* page these as `system_errors` (21× since Jul 4) while they were live. This entry is a **latent, silent safety gap** exposed by that storm, not the storm itself — and it is distinct from every prior entry, which concern the *daily-loss* circuit breaker (settlement-lag), the cron watchdog's `consecutive_fails`, alert cadence/backoff, or severity-tier noise. None touch the **per-strategy consecutive-failure kill switch** described here.

**What the data shows (verified live):**
- Active strategies are tenant-suffixed: `strategies` holds `S-001-ea207ba1`, `S-002-ea207ba1`, `S-005-ea207ba1` (`active=true`); the bare `S-001`/`S-002`/`S-005` rows are `active=false`.
- `strategy_config` holds **only the bare rows** (`strategy_id` = `S-001`, `S-002`, `S-005`), and their `updated_at` is **frozen at 2026-05-14 / 05-19** — i.e. not written once since the multi-tenant migration, despite hourly runs ever since.
- `auto-trade/index.ts:502-506` loads config via `.in("strategy_id", strategies.map(s => s.id))` — i.e. it queries for `S-001-ea207ba1…`, which **do not exist** in `strategy_config` → `configs` empty → `configMap` empty → `const config = configMap.get(strategy.id)` (`:592`) is `undefined` for **every** live strategy.
- Both kill-switch paths are gated on that value: the success-reset `if (config && …)` (`:790-793`) and the failure-increment + `is_halted` auto-halt `if (config)` (`:825-836`). With `config` always `undefined`, **neither runs** — failures are never counted, `is_halted` is never set, no `strategy_auto_halted` event, no "Strategy Halted" Telegram page.
- **Live proof:** S-001 (`S-001-ea207ba1`) threw a hard exception on essentially every cron run from `2026-07-05` through `2026-07-06 10:05` (~48 consecutive `auto_trade_strategy_error` rows) and **never auto-halted** — no `strategy_auto_halted` event exists in `compliance_log`, and `strategy_config` for `S-001` still reads `consecutive_failures: 0`, `is_halted: false`, `updated_at: 2026-05-19`. The counter never moved because the code that moves it was unreachable.

**Why it matters ($ / risk integrity):** the consecutive-failure kill switch is the safety that stops a *broken or misbehaving* strategy from running unattended — the documented behavior (`auto-trade/index.ts:36-37`: "set automatically after `max_consecutive_failures` errors"). It has been dead for ~6 weeks. In paper mode the cost was a strategy hammering a broken code path hourly for 2 days with the only backstop being the *global* health-check sweep (which pages but does not stop the strategy). The moment a strategy trades **real money**, an uncounted, never-halting failure loop is a direct capital-integrity hole — and it fails *silently* (no error, the switch simply never engages), which is the worst kind. The product thesis is a *trustworthy, risk-managed* track record; a primary circuit breaker that has been keyed to non-existent rows since May undercuts that claim without any visible symptom.

**The one improvement (ready to apply, awaiting go):**
1. **Fix the key mismatch (root cause):** make the kill switch operate on the actual runtime strategy IDs. Preferred: on each run, `upsert` a `strategy_config` row keyed on the live (suffixed) `strategy.id` when absent (seed `consecutive_failures:0`, `max_consecutive_failures:5`, `is_halted:false`), so the switch is per-tenant and self-heals. Alternative if config is meant to be per-family: strip the `-<tenant>` suffix before `configMap.get()` **and** before the `.update().eq()` writes, so reads and writes agree on the base ID. Pick one and apply it consistently to load (`:502`, `:592`), reset (`:791`), and increment/halt (`:829`).
2. **Add a guard so a disabled switch can never go silent again (fail loud):** when an *active* strategy resolves to `config === undefined`, log a `warning` (`event_type: "kill_switch_config_missing"`, strategy_id in metadata) instead of silently skipping the block. A safety mechanism that no-ops should announce itself, not vanish.
3. **Backfill:** create `strategy_config` rows for the three live suffixed strategies so the switch is armed immediately, independent of the code fix.

**Where / rollback:** `supabase/functions/auto-trade/index.ts` (config load `:499-507`, reset `:789-794`, increment/halt `:824-846`) + a one-time backfill insert into `strategy_config`. Redeploy `auto-trade` only; no migration required for the upsert approach (table already exists). Rollback: restore the current `.in()` load + `if (config)` gates and delete the backfilled rows. **Verify after:** deploy, then force an active strategy to error once (or inspect the next natural error) and confirm its suffixed `strategy_config` row's `consecutive_failures` increments and `updated_at` moves; drive it past `max_consecutive_failures` and confirm `is_halted` flips, a `strategy_auto_halted` row lands, and the "Strategy Halted" Telegram page fires. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy auto-trade --project-ref uyfnezxmgwitpzsrnkst`).

---

## 2026-07-07 (health check, ~14:10 UTC) — The `warning` severity tier is 99% noise: surface-scanner tags a *successful* scan `warning` on every run that finds a ≥10¢ edge (~288 rows/24h), so a genuine warning-severity condition is buried 1-in-289 and the tier is useless for triage

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one new improvement for this run, and it is distinct from every prior entry: those all concern the `error`/`critical` tier and the cron watchdog (the `.catch`-storm, `lesson_type` drift, `cron_failed` escalation/duplicate detection). This one is about the **`warning` tier's signal-to-noise** — an untouched failure mode.

**Health state this run:** clean. `compliance_log` shows **zero `error`/`critical` rows in the last ~28h** — the last errors of any kind were `2026-07-06 10:05–10:07 UTC` (the already-resolved `auto_trade_strategy_error` `.catch`-on-builder storm on S-001 + the `lesson_write_error` / `trade_lessons` constraint storm); the `.catch`-on-builder pattern is now gone from the codebase (grep-clean). Telegram feed quiet since the `2026-07-06 21:06` `cron_failed` page, now resolved. Surface scans running every ~5m and finding 16–17 alerts/575 markets — healthy.

**The gap:** `surface-scanner/index.ts:450` logs the routine `surface_scan_complete` event as `severity: filteredAlerts.some((a) => a.expected_edge_cents >= 10) ? "warning" : "info"`. Finding a ≥10¢ edge is the scanner **doing its job**, not a warning — and it happens on essentially every run, so the `warning` tier fills with success rows: in the last 24h, **288 of 289 `warning` rows were `surface_scan_complete`** (99.7%). The one genuine warning in that window — a single `auto_stop_loss_triggered` — is buried 1-in-289. Any human or future warning-based monitor scanning the tier for "what needs attention" is reading pure noise. (Confirmed this does **not** currently page: `health-check/index.ts:279` keys `system_errors` on `severity in ('error','critical')` only, so the mislabel costs triage clarity, not alert spam — today. It becomes an alert-fatigue source the moment anything watches `warning`.)

**The one improvement (ready to apply, awaiting go) — observability-only, no trading-path or business-logic touch:**
1. At `surface-scanner/index.ts:450`, log a completed scan at `severity: "info"` unconditionally. A successful scan that found opportunities is `info` — the edge count already lives in the message and `metadata`, so nothing is lost.
2. Reserve `warning` for a scan that is actually *degraded*: e.g. `markets.length === 0` (scanned nothing — data-feed problem) or an unusually low market count vs. the recent norm. That makes a `warning` row mean "a scan went wrong," which is what the tier is for.

**Where / rollback:** `supabase/functions/surface-scanner/index.ts:450` (one ternary → `"info"`, plus an optional zero-markets `warning` branch). Redeploy `surface-scanner` only; no schema, no trading path. Rollback: restore the ternary. **Verify after:** deploy, wait ~15m, then `select severity, count(*) from compliance_log where event_type='surface_scan_complete' and created_at > now() - interval '15 min' group by 1` — expect all `info` on healthy runs; confirm the `warning` tier now surfaces only real conditions. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy surface-scanner --project-ref uyfnezxmgwitpzsrnkst`).

---

## 2026-07-07 (health check, ~13:10 UTC) — `cron_failed` pages don't escalate: a job that fails *every run for 13 straight days* emits one near-identical low-key ❌ per day and gets banner-blindness'd — the monitor should escalate persistent failures, not repeat them

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one new improvement for this run, and it is distinct from the two prior cron entries below (duplicate/orphan detection, and the daily-digest fix itself). **System is CLEAN this run:** `cron_health()` shows all **10 active jobs green** — zero stale, zero last-run-failed (checked 13:08 UTC); `compliance_log` has **zero `error`/`critical` rows in the last ~27h** (last errors of any kind `2026-07-06 10:05–10:07 UTC`, the already-resolved S-001 `.catch`-on-builder storm + `lesson_write_error`); the last Telegram page was `cron_failed_daily-digest-cron` at `2026-07-06 21:06`, now resolved. Also verified (and did **not** raise as a false alarm): the `weather_signal_run` compliance events stopping at `2026-07-06 21:04` is **not** a stall — there is no weather-signal cron; weather runs under the healthy `signal-generator-cron` (every 15m, ran 2m ago).

**The gap:** `health-check/index.ts:§9` emits `cron_failed` with `fingerprint = cron_failed_${jobname}_${last_started_at date}` and a 12h cooldown (`health-check/index.ts:393-394`). Because the fingerprint rolls with the calendar date, a job stuck failing produces **one identical page per day, at the same low `warning`/❌ urgency, forever** — exactly what the malformed duplicate `daily-digest` job did: **13 consecutive failed runs over 13 days = 13 near-identical daily pings** (`fails_14d = 13`, per the entry below), each easy to swipe away. The monitor never says "this has now failed 13 days running" — it can't, because `cron_health()` exposes only the boolean `last_run_failed`, not a failure streak. A one-off failure and a two-week-old rot page look the same. That is how a real, cheap-to-fix incident survives 13 days.

**The one improvement (ready to apply, awaiting go) — monitoring-only, no prod/business-logic/trading-path touch:**
1. In `cron_health()` expose **`consecutive_fails`** per job — count of trailing failed runs in `cron.job_run_details` (status `failed`) since the last success. Detection is a straight window over run history, same source the RPC already reads.
2. In `health-check/index.ts:§9`, when `last_run_failed` and `consecutive_fails >= 3`: **escalate** — bump the alert severity to `critical`, prepend `🔴 STILL FAILING (${consecutive_fails} runs in a row over ${days}d)`, and switch the fingerprint to a **streak bucket** (`cron_failed_persistent_${jobname}_${bucket}` where bucket steps at 3/7/14 fails) with a **shorter 4h cooldown**, so a rotting job gets *louder and more frequent*, not the same daily shrug. Leave the single-failure path (`consecutive_fails < 3`) exactly as-is so transient blips still dedup quietly.

**Why this and not the entries below:** the `daily-digest` entry adds `cron_duplicate`/`cron_orphan` detection — it catches jobs that fail *silently* (double-firing, or disabled-but-present). This entry is the opposite failure mode: a job failing **loudly but monotonously**, where the problem isn't detection but **alert fatigue** — 13 identical pings train the operator to ignore the 14th. Defense-in-depth on the same watchdog: one closes the silent gap, this closes the noisy-but-ignored gap.

**Where / rollback:** `supabase/migrations/20260706_cron_staleness_detection.sql` (add `consecutive_fails` to the `cron_health()` RPC) and `supabase/functions/health-check/index.ts:§9` (escalation branch). New migration + `health-check` redeploy; no trading path touched. Rollback: drop the added column expression from the RPC and the escalation branch. **Verify after:** point a test cron at a guaranteed-failing endpoint, let it fail 3× (or backfill `job_run_details`), run `health-check`, confirm the page arrives as `critical` with the streak count and re-fires on the 4h cadence; then fix the job and confirm the page clears. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, migration via the management API + `supabase functions deploy health-check --project-ref uyfnezxmgwitpzsrnkst`).

---

## 2026-07-07 (health check, ~09:10 UTC) — Made the learning loop lose-proof against `lesson_type` drift: on a check-constraint rejection the lesson now falls back to `general` and is preserved, instead of being dropped

**Status:** Code change **APPLIED** (not a log-only entry) — `auto-reflect/index.ts`, failure-path only. **NOT deployed** (prod trading system — deploy is a Hard Stop awaiting Onofre's go). Type-checked with `deno check`: no new errors (the 4 reported are pre-existing loose-typing at `:374–375` + a postgrest `.d.mts` internal, all outside the edited region).

**Health state this run:** clean. Last log `2026-07-07 09:08 UTC`; all crons green. **Zero `error`/`critical` rows in the last ~23h** — the last errors of any kind were `2026-07-06 10:05–10:07 UTC` (the `auto_trade_strategy_error` `.catch`-on-builder storm on S-001, and the `lesson_write_error` / `trade_lessons_lesson_type_check` storm), both already resolved by yesterday's deploy. S-001 now runs clean (`s001_edge_below_fee_hurdle` logging normally). Telegram feed quiet.

**Why this, and why it's distinct from the prior two entries below:** the `2026-07-07 07:07` entry proposed a *CI* enum-parity check to stop `lesson_type` drift from ever shipping — good, but preventive and still unbuilt. This entry adds the **runtime** half of defense-in-depth and **actually implements it**: even if drift reaches prod (or the CI guard is skipped), the lesson content — the IF/THEN rule that is the entire point of the learning loop, i.e. the moat — is no longer thrown away. The original code did `continue` on insert failure, silently discarding ~80 lessons over 3 days (2026-07-03→07-06) when the code's `validLessonTypes` list ran ahead of the DB constraint.

**What changed (`supabase/functions/auto-reflect/index.ts`, ~line 604):** the `trade_lessons` insert payload is now hoisted to `lessonPayload`; if the insert returns Postgres `23514` (check violation) and the message names `lesson_type`, the row is re-inserted once with `lesson_type: "general"` (always in the constraint) and a `lesson_type_constraint_drift` warning is logged to `compliance_log` naming the rejected type so the constraint gets updated. Only fires on the failure path — the happy path is byte-for-byte unchanged.

**Where / rollback:** `supabase/functions/auto-reflect/index.ts`. Rollback: revert to the single inline insert + `continue`. **Verify after deploy:** temporarily emit a bogus `lesson_type`, confirm the lesson row still lands as `general` and one `lesson_type_constraint_drift` warning fires. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy auto-reflect --project-ref uyfnezxmgwitpzsrnkst`). Pairs with — does not replace — the still-recommended CI enum-parity guard from the `07:07` entry.

---

## 2026-07-07 (health check, ~scheduled run) — The malformed duplicate `daily-digest` cron that paged Telegram every night for 13 days was only ever caught *because it kept failing* — the monitor has no duplicate/orphan-job detection, so a superseded cron that stays silent (disabled, or worse: succeeds while double-firing) would never alert

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one *new* improvement for this run. **The Telegram feed is CLEAN as of this run:** zero `error`/`critical` rows in `compliance_log` in the last ~21h (last error of any kind `2026-07-06 10:07 UTC`, the already-resolved `lesson_write_error` / `.catch is not a function` storm). The last Telegram page was the recurring `cron_failed_daily-digest-cron` at `2026-07-06 21:06` — and that is now resolved too: the broken job (jobid 19) has been unscheduled, its clean replacement (jobid 20, `daily-digest-cron`, headers built via `jsonb_build_object`) succeeded at `2026-07-06 22:00`, and the current cron set is exactly **10 active jobs, one per endpoint, zero inactive orphans, zero duplicates** (verified against `cron.job`). This entry is a *structural monitoring gap* that the just-closed incident exposed, distinct from the auto-settle P&L/expiration entries below.

**What happened (verified — `cron.job_run_details`):** two cron jobs both POSTed to `/functions/v1/daily-digest`. jobid 20 was the correct replacement; jobid 19 was a superseded duplicate whose `Authorization` header was hand-built by string concat and carried a stray pipe — `'Bearer ' | ...` — so every nightly run died at the SQL layer with `invalid input syntax for type json / Token "|" is invalid`, **before the HTTP call even fired.** It failed **13 times over 13 days** (`fails_14d = 13`, last fail `2026-07-05 22:00`) and generated a fresh `cron_failed` Telegram page each day.

**The gap (this run's one new improvement):** the only reason this surfaced is that jobid 19 *failed loudly* — `cron_health()` and `health-check` (`health-check/index.ts:§9`) detect exactly two conditions per job: **stale** (overdue vs learned cadence) and **last-run-failed**. Neither can see a **duplicate**: two active jobs hitting the same endpoint. That leaves two silent failure modes wide open — (a) a superseded job left `active=false` (there are zero today, but nothing would page if one appeared — `active=false` jobs never run, so never "fail" and never go "stale"), and (b) the more dangerous case, a duplicate that *succeeds* — two working jobs on the same endpoint would **double-fire** `daily-digest` (or, if it were `auto-trade`, place duplicate trades) with every run reading green. The monitor equates "not failing" with "healthy"; a duplicate that isn't failing is invisible.

**The one improvement (ready to apply, awaiting go) — monitoring-only, no prod/business-logic touch:** add a **duplicate-endpoint check** to `cron_health()` / `health-check`. The detection query is already proven this run:

```sql
SELECT substring(command FROM '/functions/v1/([a-z-]+)') AS endpoint,
       count(*) AS active_jobs, array_agg(jobid) AS jobids
FROM cron.job
WHERE active = true AND command LIKE '%functions/v1/%'
GROUP BY 1 HAVING count(*) > 1;
```

Any row returned → page a new `cron_duplicate` alert (`fingerprint = cron_duplicate_${endpoint}`, 12h cooldown) naming the endpoint and the colliding jobids. Optionally also flag `active=false` jobs that still exist (`cron_orphan`) so a disabled-but-not-deleted job can't linger unseen. ~15 lines added to the `cron_health()` RPC (or computed inline in `health-check`), consistent with the existing dedup/fingerprint pattern.

**Where:** `supabase/migrations/20260706_cron_staleness_detection.sql` (extend the `cron_health()` RPC with the duplicate/orphan rows), and `supabase/functions/health-check/index.ts:§9` (emit the new `cron_duplicate` / `cron_orphan` alerts alongside `cron_stale` / `cron_failed`). New migration + `health-check` redeploy; no change to any trading path. Rollback: drop the added rows from the RPC and the two alert blocks. **Verify after:** temporarily `cron.schedule` a second job onto an existing endpoint, run `health-check`, confirm one `cron_duplicate` page fires naming both jobids and that it dedups on the next run; then unschedule the test job and confirm the page clears. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, migration via the management API + `supabase functions deploy health-check --project-ref uyfnezxmgwitpzsrnkst`).

**Root-cause note (for the backlog, not this entry's fix):** the deeper cause is that pg_cron jobs are created imperatively via ad-hoc `cron.schedule` SQL with no single source-of-truth file, so a hand-run statement (like jobid 19's) can drift from the migration-defined set and linger. A canonical "declare all 10 jobs" migration that `cron.unschedule`s anything not in the list would make orphans structurally impossible — larger change, worth its own entry if the duplicate-detection guard isn't deemed sufficient.

---

## 2026-07-07 (health check, ~07:07 UTC) — The two bugs that spammed Telegram Jul 5–6 were fixed reactively, but the regression guards their own log entries prescribed were never built — so they can silently return

**Status:** Improvement logged — CI guards NOT yet implemented. Scoped CI-only (no prod/business-logic/DDL change), safe to build on approval.

**Health state this run:** clean. All 10 pg_cron jobs green and current (`agent_cron_health`, none stale). **Zero `error`/`critical` rows in the last ~21h** — last error of any kind `2026-07-06 10:07 UTC`. Telegram feed quiet apart from the already-logged `cron_failed_daily-digest-cron` page. Both Jul 5–6 incidents are confirmed fixed *in the live system*, not just code: the bare-`.catch()`-on-Supabase-builder pattern is gone from all edge functions, and the `trade_lessons_lesson_type_check` constraint now matches `validLessonTypes` (`auto-reflect/index.ts:458`) — all 8 values present (migration `20260706_trade_lessons_lesson_type_expand.sql`).

**The gap (this run's one new improvement):** both fixes were one-offs. Each `2026-07-06` entry below *prescribed* a regression guard — a CI grep block on `.catch(` chained to a `from(...)` builder, and a code↔DB parity check for the `lesson_type` enum — **and neither was built.** Verified: `.github/workflows/ci.yml` has no such guard, and no test asserts `validLessonTypes` equals the DB constraint. Until they exist, the next added `lesson_type` or the next bare `.catch()` re-opens the exact incident that paged Telegram hourly for ~24h and (for the lesson bug) dropped lessons from the learning loop — the moat.

**Fix (two CI guards, no prod touch):**
1. **`.catch()` guard** — a `ci.yml` step that fails on any `\.(from|rpc)\([^)]*\)[\s\S]*?\.catch\(` chain under `supabase/functions/**`. Kills the runtime-`TypeError` class for good.
2. **Enum-parity check** — a step that reads the `trade_lessons_lesson_type_check` constraint and asserts its value set equals `validLessonTypes`; fails loud on drift *before* a lesson is dropped in prod.

**Verification plan:** push a branch, prove a deliberately-introduced bare `.catch()` fails CI and removing a value from the DB constraint fails the parity check, then confirm the real code passes both. CI-only — no deploy required.

**Bookkeeping:** the two `2026-07-06` entries still read "not yet fixed/deployed." The DB proves both shipped — mark them **Resolved (verified 2026-07-07)**.

---

## 2026-07-07 (health check, ~06:12 UTC) — The force-expire safety net can't reach a trade with a NULL `expiration_time` — so 12 of the 14 currently-open positions are invisible to the one sweep meant to rescue stuck-open trades

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one *new* improvement for this run. **The Telegram feed is CLEAN:** the `lesson_write_error` storm that dominated the feed (103 pages for trade `2ae0d30e` / KXHIGHNY-26JUL02-B99.5) **stopped at 2026-07-06 10:07** and has zero recurrences since — resolved by migration `20260706_trade_lessons_lesson_type_expand.sql`, which added `stale_signal`/`kelly_mismatch` (and the rest of `validLessonTypes`) to the DB constraint the inserts were violating. The July-6 `trading_silence` alert is also stale: trades are filling again (last three at 2026-07-07 03:05, `status=filled`). The only remaining Telegram noise is the date-stamped `cron_failed_daily-digest-cron` page — already logged repeatedly below. This entry is a *different, structural* settlement-integrity hole I found reading the auto-settle sweep, distinct from the 2026-07-07 05:12 entry (that was about the **`pnl: 0`** *value* booked on expiry; this is about trades that **never reach the sweep at all**).

**What the code does (verified — `auto-settle/index.ts:383-395`):** step 6, the "expiration sweep," is explicitly the last-resort net for "trades placed on markets that have since finalized and left the Kalshi API — `fetchKalshiMarket()` returns null for them, leaving them stuck open forever unless this sweep runs" (its own comment). But the query force-closes only rows matching `status='filled' AND settled_at IS NULL AND `**`expiration_time IS NOT NULL`**` AND expiration_time < now()-4h`. The `.not("expiration_time", "is", null)` clause (`:394`) means **any filled trade whose `expiration_time` is NULL is silently excluded** — the sweep can never touch it. The same blind spot exists in the 2-hour early-exit path (`auto-trade/index.ts:1350-1351`, identical `.not(...is null)` filter).

**Why the population it excludes is exactly the at-risk one (verified live):** `expiration_time` is NULL for **12 of the 14** currently-open (`status='filled'`, `settled_at IS NULL`) trades — e.g. `KXBTC-26JUL1017-B65250` (filled 2026-07-03), three `KXINX-26JUL10H1600` legs (filled 07-04), and today's `KXINX-26JUL07H1600` legs. Root cause is write-side: `execute-trade/index.ts` inserts `expiration_time: expirationTime || null` at five call sites (`:344,374,443,530,578`), so whenever the deadline isn't derivable from the order response it persists NULL — which is the *common* case, not the edge case. Net effect: a trade with no stored expiration has **only one** settlement path (result-polling); the moment its market finalizes and drops off the Kalshi API, the result poller returns null *and* the expiry sweep skips it, and it hangs `filled` forever. The safety net has a hole shaped precisely like its own weakest data.

**Why it matters ($ / track-record integrity):** the product thesis is a *trustworthy, risk-managed* paper track record — the artifact that gates the uncle-capital unlock. A stuck-open `filled` trade silently distorts that record three ways: it inflates `open_position_count` (a live input to the `max_open_positions` risk gate at `auto-trade:675`, so a phantom-open trade can *block real new trades*), it ties up notional capital that was actually released, and it means the position's true win/loss never lands in P&L or in the learning loop. It's silent — no error, no alert (the sweep logs `severity: info` and simply reports a lower count) — which is the most dangerous kind of track-record drift. Today it's 12 of 14; every new trade booked without an expiration deepens the backlog.

**The one improvement (ready to apply, awaiting go) — cheapest first:**
1. **Let the sweep fall back to the ticker-parsed deadline (small, no schema):** the codebase already parses a settlement date from the ticker — `auto-trade/index.ts:219-250` does exactly this ("Prefer stored expiration_time; fall back to ticker parsing for older trades"). Reuse that parser inside the expiry sweep: for rows with NULL `expiration_time`, compute the deadline from the ticker (`KXBTC-26JUL1017` → 2026-07-10 17:00, `KXINX-26JUL07H1600` → 2026-07-07 16:00) and apply the same `< now()-4h` test. Closes the net's hole without touching the write path.
2. **Fix the write-side so `expiration_time` is populated at insert (small):** in `execute-trade`, when the order response carries no expiration, derive it from the ticker (same parser) before insert instead of storing NULL — so the field is reliable going forward and the fallback in (1) becomes belt-and-suspenders.
3. **Backfill the 12 open NULLs (one-time query):** parse and set `expiration_time` for the existing open trades so they immediately become sweep-eligible, then let the next auto-settle run reconcile any already-finalized ones against Kalshi (booking the true result, not `pnl: 0` — see the 05:12 entry).

**Where:** `supabase/functions/auto-settle/index.ts:383-395` (add the ticker-parse fallback to the sweep — reuse the `auto-trade:219-250` parser, ideally lifted into `_shared/`), `supabase/functions/execute-trade/index.ts:344/374/443/530/578` (derive expiration at insert), optionally `auto-trade/index.ts:1350-1351` (same fallback for the 2h-exit path), plus a one-time backfill over `trades WHERE status='filled' AND settled_at IS NULL AND expiration_time IS NULL`. ~15-30 lines, no migration. Rollback: restore the `.not(...is null)` filter. Verify after: seed a filled trade with NULL `expiration_time` and a ticker deadline > 4h in the past, run `auto-settle`, confirm it force-expires (it currently would not); confirm `open_position_count` drops to the true live count. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy auto-settle --project-ref uyfnezxmgwitpzsrnkst`).

---

## 2026-07-07 (health check, ~05:12 UTC) — auto-settle's expiry sweep books every force-expired position at `pnl: 0`, erasing the realized loss — so the paper track record silently overstates P&L

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one *new* improvement for this run. **The Telegram feed is CLEAN:** zero `error`/`critical` rows in `compliance_log` in the last 12h, health-check sweep "all clear" at 04:10, and the two bugs prior runs chased are confirmed resolved — the `.catch is not a function` strategy crash and the `lesson_type` constraint violation both stopped firing at 2026-07-06 10:05/10:07 and have not recurred (Surface-Arb has run clean every cycle since; the stuck trade `2ae0d30e` wrote its `stale_signal` lesson at 10:30). I also checked the "14 still pending" trades — **not a stall:** 12 are future-dated (BTC/INX hourly, Jul-10 close) and the 2 Jul-06 weather legs show `status=closed, result=""` on Kalshi with `expiration_time 2026-07-13`, i.e. Kalshi itself hasn't settled them yet. auto-settle is behaving correctly there. This entry is a *different, structural* accounting gap I found reading the settle path.

**What the code does (verified — `auto-settle/index.ts:383-415`):** step 6, the "expiration sweep," selects every `status='filled'`, `settled_at IS NULL` trade whose `expiration_time < now()-4h` and force-closes it with a **hard-coded `pnl: 0`, `resolution: 'expired'`**. The comment's intent is sound — a market that finalized and aged out of the Kalshi API returns `null` from `fetchKalshiMarket()`, so without this sweep those trades hang open forever. The bug is the **`pnl: 0`**: a `filled` trade paid premium, and a binary that expires never realizes at your entry cost — it either paid out or went to zero. Booking it flat is the one value guaranteed wrong, and it always errs toward *flattering* the record (a losing leg that should be `−premium` is recorded as break-even).

**Live evidence (verified this run):** 85 trades sit in `status='expired'`, **every one with `pnl=0`**, against `sum(amount)=12703` of recorded premium. Several are unambiguous losses booked flat — e.g. `KXHIGHMIA-26APR15-T84`, `side=yes` bought at `2¢`, **`resolution='no'`** (the YES bet lost), `pnl=0`. Six expired rows even carry a known losing `resolution='no'` and are *still* booked at 0. So this isn't only the "unknowable result" case the comment describes — the sweep is zeroing trades whose loss is already determined.

**Why it matters ($ / moat):** the entire product thesis is a *trustworthy, risk-managed* paper track record — the artifact that gates the uncle-capital unlock and any future AUM. A settlement path that systematically books expired losers at $0 inflates cumulative P&L and win-rate by exactly the premium of every position that expired against us. It's silent (no error, no alert — it looks like normal housekeeping), which is the most dangerous kind of track-record distortion: the headline number drifts optimistic while every dashboard reports "all clear."

**The one improvement (ready to apply, awaiting go) — cheapest first:**
1. **Book the true outcome when it's known (small, no schema):** before force-expiring, do one final `fetchKalshiMarket()` / settlement-result read; if a `result` is available, settle with real `pnl` instead of 0. For rows that already carry a losing `resolution` (like the 6 above), compute `pnl = −premium` rather than 0.
2. **When the result is genuinely unretrievable, book `−premium`, not 0 (conservative default):** a held binary that vanished from the API is far more likely a loss than a break-even; defaulting to `−amount` keeps the track record honest-to-pessimistic rather than optimistic. At minimum, tag these rows `resolution='expired_unknown'` and **exclude them from headline P&L / win-rate** so they can't silently flatter the aggregate.
3. **Backfill the 85 existing rows:** recompute `pnl` for expired trades that have a known `resolution`, and re-tag the truly-unknown ones, so the historical track record shown to capital is corrected once.

**Where:** `supabase/functions/auto-settle/index.ts:383-415` (the expiry-sweep UPDATE — replace the constant `pnl: 0`), and a one-time backfill query over `trades WHERE status='expired'`. ~15-30 lines, no migration. Rollback: revert the sweep to the constant. Verify after: force-expire a known-losing test trade and confirm `pnl = −premium` (not 0); confirm headline cumulative P&L drops by the corrected losses after backfill. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy auto-settle --project-ref uyfnezxmgwitpzsrnkst`).

---

## 2026-07-07 (health check, ~04:15 UTC) — The daily-loss circuit breaker reads a `daily_pnl` that only refreshes on order *placement*, never on settlement — so it lags realized losses and can be defeated by same-window loss clustering

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one *new* improvement for this run. **The Telegram feed is CLEAN right now** — zero `error`/`critical` rows in `compliance_log` in the last 18h; hourly Surface-Arb runs are all `completed`; no strategy halted; `risk_state` shows no user currently halted. Two things I chased this run turned out already-resolved and are *not* re-logged: the `.catch is not a function` strategy crash stopped at 2026-07-06 10:05 (Surface Arb has run clean every hour since), and the "stop-loss lost 100% (threshold 15%)" mislabel was fixed by the daily-PnL breaker that **deployed at 21:13 UTC Jul 6** (auto-settle v45) — verified via the function's `updated_at` and by the -$15 KXINX settlement at 23:02 that correctly did *not* fire the old per-trade halt. This entry is about a *structural gap inside that freshly-shipped breaker* — not the switch itself.

**What the data shows (verified live):** `risk_state.daily_pnl` is the value the daily-loss circuit breaker keys on, and its **only writer is `execute-trade/index.ts:695-717`** — confirmed three ways: no DB trigger on `trades`, no `pg_proc` referencing `daily_pnl`, and no `daily_pnl:` write anywhere in `auto-trade` or `auto-settle` (both only upsert `is_trading_halted`/`halt_reason`). execute-trade recomputes it correctly (`actualDailyPnl` = sum of today's *settled* trades) — but **only when a new order is placed.** `auto-settle` realizes the loss on a settling trade and reads `daily_pnl` for the breaker (`:326` `dailyPnl = stateRow.daily_pnl + pnl`) but **never writes the realized loss back.** Live evidence: on 2026-07-06 `risk_state.daily_pnl = 3.85`, last updated **21:05** — yet KXINX-26JUL06H1600-B7537 settled **-$15 at 23:02**, and that loss never entered `daily_pnl` (it stayed 3.85, then reset to 0 today). The stored day-total omitted a realized loss for ~7h until day-rollover.

**Two concrete failure modes (both live-reachable):**
1. **Loss-clustering under-count.** auto-settle processes settlements in a loop; each losing trade reads the *same* stored `daily_pnl` and evaluates `stored + own_pnl` — never the cumulative sum of the batch. Kalshi's short-dated binaries settle in tight windows (weather ~11:00, BTC/index hourly on the hour), so a bad window of, say, 4 × -$15 = -$60 is seen by the breaker as four independent `base + (-15)` checks, never as -$60. The one control meant to catch "a bad day" can be walked straight through by the exact clustered-loss day it exists for.
2. **Stale pre-trade gate.** auto-trade's own pre-trade `evaluateRisk` (`auto-trade:719-726`) also reads `daily_pnl`. Between a settlement and the next order placement, that value lags realized losses — so the pre-trade daily-loss gate can green-light a new trade on a day that has *already* blown the limit but hasn't been re-summed yet.

**Why it matters ($ / risk integrity):** removing the per-trade 15% stop (correct — binaries always realize 100% on a losing settle) makes the **daily-loss limit the primary, and effectively sole, downside circuit breaker.** A breaker that reads P&L lagging realized losses, and that under-counts precisely when losses cluster, is a risk control that under-reports risk exactly when it matters most. The whole product thesis is a *trustworthy, risk-managed* paper track record — the artifact that gates the uncle-capital unlock; a circuit breaker that can be defeated by normal settlement timing undermines that claim silently (no error, no alert — it just doesn't halt).

**The one improvement (ready to apply, awaiting go) — cheapest first:**
1. **Recompute-and-persist at settlement (small, no schema):** in auto-settle's settlement loop, after computing each trade's `pnl`, do the same authoritative recompute execute-trade already does — `SELECT sum(pnl) FROM trades WHERE status IN ('settled','finalized') AND settled_at >= today AND user_id = t.user_id` — and `upsert` it into `risk_state.daily_pnl` **unconditionally** (not only on halt). Then evaluate the breaker against that persisted true total. Closes both failure modes; ~8 lines; zero trading-logic change.
2. **Single shared helper (durable):** extract the "recompute today's realized `daily_pnl` from settled trades and upsert `risk_state`" block (currently only in execute-trade:695-728) into `_shared/risk.ts` and call it from **both** execute-trade and auto-settle. Removes the drift class entirely so the two write paths can't diverge again.
3. **Batch-aware evaluation (belt-and-suspenders):** since a settle run can close several trades at once, evaluate the halt on the *post-batch* recomputed total once per run per user, rather than per-trade against a pre-batch base.

**Where:** `supabase/functions/auto-settle/index.ts:307-368` (add the recompute+persist, evaluate breaker against it) and optionally `_shared/risk.ts` (new shared helper) + `execute-trade/index.ts:695-728` (call it). ~8-25 lines, no migration, zero trading-logic impact. Rollback: drop the extra upsert / restore the inline read. Verify after: settle ≥2 losing trades in one window whose sum exceeds `max_daily_loss`, confirm the breaker halts on the batch (it currently would not), and confirm `risk_state.daily_pnl` matches `sum(pnl)` of today's settled trades immediately after a settle run (not only after the next order). Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy auto-settle --project-ref uyfnezxmgwitpzsrnkst`).

---

## 2026-07-07 (health check, ~03:15 UTC) — Give the lesson-write orphan loop a give-up guard: a trade whose `trade_lessons` INSERT permanently fails is re-selected and re-paged every run, forever

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one *new* improvement for this run. **The Telegram feed is CLEAN right now** — `cron_health()` shows all 10 active crons `last_run_failed=false`, no stale jobs; the last error/critical row in `compliance_log` was 10:07 UTC Jul 6; today's 03:05 auto-trade run logged `3 ran, 1 traded, 0 errors, 0 halted`. The two bugs that drove this week's noise (the `lesson_type` constraint drift and the `.catch is not a function` strategy crash) are both already logged below and fixed. This entry is about the *structural* flaw those bugs exposed in the lesson-write path — the reason a single bad trade turned into 80 pages — not either bug itself. Distinct from the `system_errors` backoff entry directly below: that hardens the *health-check* re-page cadence; this hardens the *auto-reflect edge function's own* alert + retry behavior at the source.

**What the data shows (verified live):** trade `2ae0d30e-fc43-4ddb-b0bc-bb61a64100e4` (KXHIGHNY-26JUL02-B99.5) fired `lesson_write_error` **80 times over 3 days** — first `2026-07-03T11:32`, last `2026-07-06T10:07` — one per hourly `auto-reflect` run, every run raising a raw Telegram page. Root mechanism: the catch-up query (`auto-reflect/index.ts:431-444`) selects settled nonzero-P&L trades that have **no `trade_lessons` row yet**, with the comment *"No time limit — recovers from schema bugs."* That recovery is one-directional: it re-picks an orphan every run until a lesson row appears. For a trade whose lesson INSERT **structurally cannot succeed** (a constraint violation, RLS denial, NOT NULL/bad-data, or a future schema check), the row never appears — so the trade is an eternal orphan, re-failing and re-paging every hour with no exit. Compounding it, the inner failure path (`:622-630`) alerts with **raw `sendTelegramAlert` (`:629`) and no dedup**, unlike the outer loop-crash catch (`:712`) which correctly uses `alertOnce`. So the inner path has neither a give-up cap nor page-rate limiting.

**Why it matters ($ / signal):** this is the same alert-fatigue failure the entries below fight, but at its source — 80 identical pages for one trade is what trains the operator to swipe the Telegram feed away, which is exactly when the *next real* degradation gets missed. Trustworthy alerting is a prerequisite for the paper-trading track record that gates the uncle-capital unlock. Two prior fixes patched *specific causes* (the `23514`/`lesson_type` → `general` fallback below; the health-check backoff directly below); neither closes the *general* case — any future reason a lesson INSERT can't land re-opens the exact same 80-page loop. Fix the system that allowed it, not just this week's trigger.

**The one improvement (ready to apply, awaiting go) — cheapest forms first:**
1. **Rate-limit the inner alert (1 line, no schema):** change `:629` from `sendTelegramAlert(...)` to `alertOnce(supabase, "lesson_write_error", trade.id, 24, ...)` keyed on `trade.id`. Caps a single failing trade to one page/day instead of ~24. Kills the page storm immediately; does not stop the wasted re-processing.
2. **Dead-letter the orphan (no migration):** on INSERT failure, write a sentinel `trade_lessons` row (`lesson_type:"general"`, `outcome`, note *"auto-reflect: insert failed, quarantined"*) so the trade *gets* a row and drops out of the catch-up orphan set. Combined with the existing `general` fallback, this closes the loop with zero schema change.
3. **Attempt counter (durable, migration):** add `reflection_attempts int default 0` (+ `reflection_failed_at timestamptz`) to `trades`; increment on failure; exclude `reflection_attempts >= 3` from the catch-up query and fire one summary `lesson_write_quarantine` alert at the cap. Cleanest long-term — makes "gave up on this trade" a first-class, queryable state instead of inferred silence.

**Where:** `supabase/functions/auto-reflect/index.ts` — inner failure path `:622-630` (swap raw alert for `alertOnce` / write sentinel row) and the catch-up selection `:431-444` (exclude quarantined trades). ~1–15 lines depending on option, zero trading-logic impact; options 1–2 need no migration. Rollback: restore the raw `sendTelegramAlert` / drop the sentinel branch. Verify after: seed a trade that fails the `trade_lessons` INSERT (e.g. a deliberately invalid `lesson_type` pre-fallback), run `auto-reflect` 3×, confirm ≤1 page and that the trade stops being re-selected. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy auto-reflect --project-ref uyfnezxmgwitpzsrnkst`).

---

## 2026-07-07 (health check, ~01:10 UTC) — Give the generic `system_errors` sweep an escalating backoff so a single known bug can't re-page every 2h for days

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one *new* improvement for this run. **The Telegram feed is CLEAN right now** — the last 14 hourly health-checks are all-clear, last error/critical row was 10:07 UTC Jul 6, crons all firing, 8 trades in 24h, and the learning loop is healthy (0 of 87 settled trades in 14d missing a `trade_lesson`). The two root bugs that drove this week's noise — the `trade_lessons` lesson_type drift and the `.catch is not a function` strategy crash — are both already logged below and fixed. This entry is about the *alerting mechanism* that turned those two bugs into ~40 pages, not the bugs themselves.

**What the data shows (verified live):** `compliance_log` holds **41 `system_errors` Telegram pages over the 5 days Jul 2 → Jul 6** (`event_type=health_check_alert`, `alert_type=system_errors`) — roughly one every 2–3h, unbroken, for the *same* two underlying conditions the whole time. The generic error sweep (`health-check/index.ts:289-293`) fingerprints on `errors_${recentErrors[0].event_type}_${message.slice(0,60)}` with a flat **`cooldownHours: 2`**. So any persistent error/critical condition re-pages every 2h indefinitely: a bug that takes a day to fix pages ~12×, one that lingers a work-week pages ~40× — exactly what happened. The fingerprint also keys only on the *first* row, so once the top error clears but a second one persists, the cadence just resets on the survivor.

**Why it matters ($ / signal):** this agent's entire safety net is Telegram. 40 identical pages for a known, already-being-worked bug is textbook alert fatigue — it trains the operator to swipe the feed away, which is precisely when the *next, genuinely new* `system_errors` page (a real degradation) gets missed. Trustworthy alerting is a prerequisite for the paper-trading track record that gates the uncle-capital unlock; a channel that cries wolf every 2h for a week erodes exactly that trust. (This is the same "clean, trustworthy alerting" theme as the `surface_scan_complete` severity entry below, but a different mechanism: that one is a mis-severity'd routine row; this is the *re-page cadence* of the error sweep itself.)

**The one improvement (ready to apply, awaiting go):** replace the flat 2h cooldown on the generic `system_errors` sweep with an **escalating backoff keyed on how many times the same fingerprint has already paged** — e.g. 2h → 6h → 24h → 24h. A genuinely new error still pages within one cron cycle (fast when it matters); a known-and-persisting one decays to one reminder/day instead of 12. Cheapest forms first:
1. **Count-based backoff (no schema):** before pushing the `system_errors` alert, count prior `health_check_alert` rows with the same fingerprint (already queryable — `isDuped` does an identical lookup); map the count to a cooldown (`[2,6,24][Math.min(n,2)]`h) instead of the constant `2`. ~5 lines, reuses the existing dedup store.
2. **Apply the same treatment to the structured `api_error_*` sweep** (`health-check/index.ts:347`, also `cooldownHours: 2`) so provider 429/5xx storms decay identically.
3. **Optional escalation flip:** if a fingerprint is *still* firing after 48h, re-raise it once at higher prominence (`🔴🔴 STILL UNRESOLVED 48h+`) so decayed-but-unfixed doesn't become invisible — backoff should quiet a known issue, not bury a neglected one.

**Where:** `supabase/functions/health-check/index.ts:289-293` (the `system_errors` push) and `:340-352` (the `api_error_*` push). ~5–15 lines, zero trading-logic impact, no migration. Rollback: restore the constant `cooldownHours: 2`. Verify after: trigger a synthetic persistent error, confirm pages arrive at 2h then 6h then 24h spacing rather than every 2h. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy health-check --project-ref uyfnezxmgwitpzsrnkst`).

---

## 2026-07-07 (health check, ~00:10 UTC) — Close the watchdog's last blind spot: a cron *removed* from the scheduler is invisible to `cron_health()` (a job can't be flagged stale if it's no longer a row)

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one *new* improvement for this run. **No live errors on the Telegram feed right now** — the last three hourly checks (21:10, 22:10, 23:10 UTC) fired zero alerts; all 10 active crons last ran `succeeded`, none stale, none failed. Earlier today the feed *did* carry `system_errors` (08:10, 11:10) and `cron_failed` (21:06), all since resolved — those are already covered by prior entries below, not re-logging.

**What the data shows (verified live):** `cron.job` now holds **10 jobs**, but today's staleness migration (`20260706_cron_staleness_detection.sql`) and its own header describe an **"11-job fleet."** The missing job is **`weather-signal-cron`** — the exact job that triggered today's incident (parked to `59 23 31 2 *` = Feb 31, silently dead ~3h). It wasn't rescheduled; it was **removed from `cron.job` entirely** (`select max(start_time) from cron.job_run_details` for it → `NULL`; no jobid remains). Meanwhile `backtest-weather-daily` is still active and succeeding nightly — so the weather strategy is still in the fleet, but its *live signal generation* has no scheduled trigger.

**The blind spot (root):** `cron_health()` computes staleness with `FROM cron.job j LEFT JOIN last_runs`. It can only report on jobs that *exist as rows*. A job that is **deleted/unscheduled** — the precise fate of `weather-signal-cron` — produces no row, so it can never be `is_stale` or `last_run_failed`. Today's migration closed the "parked to a never-date, still a row" case; it did **not** close the "no longer a row at all" case. The watchdog cannot distinguish *intentionally decommissioned* from *accidentally dropped* — both look identical: silence. That is the same failure signature (silence, not a page) the dead-man's-switch entry flags, but at the per-job level.

**Why it matters ($ / signal):** every safety signal here is "did the expected thing happen." A strategy whose cron is dropped — by a botched `cron.unschedule`, a migration that recreates jobs, or a manual edit — stops trading with zero alert, and the track record (the artifact gating the uncle-capital unlock) quietly loses a strategy's worth of signal. If `weather-signal-cron`'s removal was *unintentional*, live weather signals are already dark right now and nothing said so.

**The one improvement (ready to apply, awaiting go):** monitor against a **canonical expected-jobs manifest**, not against `cron.job` alone.
1. **Manifest table + LEFT JOIN (durable):** a small `expected_crons(jobname, expected_interval_s, active_expected)` table listing the full 11-job fleet. Extend `cron_health()` to `RIGHT JOIN` (or `FROM expected_crons LEFT JOIN cron.job`) so a manifest job with **no matching `cron.job` row** surfaces as a new `is_missing` condition; `health-check` fires a `cron_missing` alert (dedup fingerprint on `jobname`, ~6h re-alert, same shape as `cron_stale`).
2. **Cheaper interim (no schema):** hardcode the expected jobname set in `health-check/index.ts`, diff it against the `cron_health()` rows, and alert on any expected name absent from the result. ~10 lines, no migration.
3. **Immediate, separate:** decide `weather-signal-cron`'s intended state — if live weather signals are still wanted, re-add its schedule (per deploy protocol); if decommissioned, remove it from the "11-job fleet" language so the manifest count is honest.

**Where:** `supabase/functions/health-check/index.ts` (new `cron_missing` alert branch alongside the `cron_stale`/`cron_failed` branches at ~L374-397) + optionally a `cron_health()` revision in a new migration. ~10–30 lines, zero trading-logic impact. Rollback: drop the manifest / remove the branch. Verify after: temporarily unschedule a throwaway test job → confirm a `cron_missing` alert fires within one health-check cycle.

---

## 2026-07-06 (health check, ~23:15 UTC) — Make `surface_scan_complete` severity discriminating: it fires `warning` on ~100% of scans, drowning the alert feed

**Status:** Logged — NOT applied (no code change or deploy this run). This is the one *new* improvement for this run. The two live errors on the Telegram feed (`cron_failed: daily-digest-cron` and the `.catch is not a function` strategy crashes) are already logged with ready fixes in prior entries below, all awaiting Onofre's deploy go (Hard Stop) — not re-logging.

**What the data shows (verified live):** `surface-scanner/index.ts:450` sets `severity: filteredAlerts.some(a => a.expected_edge_cents >= 10) ? "warning" : "info"`. In practice a ≥10¢ edge is present on essentially every scan — `compliance_log` holds **2,016 `surface_scan_complete` rows at `severity='warning'` over the last 7 days** (Jun 29 → Jul 6), i.e. ~288/day, one on nearly every 5-min run. A severity flag that is "warning" ~100% of the time carries zero information: it can no longer distinguish a notable scan from a routine one.

**Why it matters ($ / signal):** `compliance_log` is the shared substrate the whole safety net reads from — the observability page, the `health-check` sweep, and the `alertOnce` dedup logic all query it, frequently by severity. 288 routine "warning" rows/day (~8.6k/month) bury the genuinely actionable warnings — `auto_stop_loss_triggered`, `health_check_alert`, real degradations — under scan-completion spam, and inflate storage/read cost on a hot table. Clean, trustworthy alerting is a prerequisite for the track record artifact (the uncle-capital unlock); a feed that cries "warning" every 5 minutes trains everyone to ignore it. (Note: the flip side — that the scanner surfaces ≥10¢ surface-arb edges on nearly every scan while S-001 `runS001SurfaceArb` sits crashed on the `.catch` bug — is the *execution* gap already logged below; this entry is strictly about the logging signal.)

**The one improvement (ready to apply, awaiting go):** make the `warning` bar mean something rare, or drop the routine row to `info`. Cheapest first:
1. **Reclassify to `info` (safe, 1 line):** `surface_scan_complete` is a completion event, not a warning — the actionable data already lives in the `surface_alerts` table. Set `severity: "info"` unconditionally and let the alerts table, not the log severity, carry opportunity signal. Matches the codebase convention (`market_data_fetch`, `auto_settle_run`, `weather_signal_run` all log `info`).
2. **Or raise the discriminating threshold** so `warning` fires only on a genuinely notable scan — e.g. a *new* ≥25¢ edge not present in the prior scan, or an abnormal drop in `total_markets` (a real scan-degradation signal). That keeps a useful warning without the flood.
3. **Or throttle the summary** — log the routine completion once/hour instead of every 5-min run (12 rows/day instead of 288), still enough for observability.

**Where:** `supabase/functions/surface-scanner/index.ts:448-451`. ~1–5 line change, zero trading-logic impact. Rollback: revert the ternary. Deploy per protocol (`$SUPABASE_ACCESS_TOKEN_KTA`, `supabase functions deploy surface-scanner --project-ref uyfnezxmgwitpzsrnkst`). Verify after: `surface_scan_complete` warning rows drop to ~0/day (or ~12 under option 3) while real `warning`/`error` rows are unaffected.

---

## 2026-07-06 (health check, ~22:08 UTC) — Add an external dead-man's-switch so the watchdog itself can't die silently

**Status:** Logged — NOT applied (no code change made this run). This is the one *new* improvement for this run. The only live error on the Telegram feed right now is `cron_failed: daily-digest-cron`, already logged at 21:15 UTC with a ready-to-run fix awaiting Onofre's go (Hard Stop) — not re-logging it here.

**The gap:** the monitoring stack is now genuinely strong — dedup'd alerts, a crash-alert path in `health-check`, and cron-staleness/failure detection via `cron_health()` (shipped today, `20260706_cron_staleness_detection.sql`). But every one of those signals depends on the `health-check` pg_cron job *actually firing*. Nothing watches the watchdog itself. `cron_health()` can report that other jobs are stale, but it cannot report its own staleness — if the health-check cron is paused, the function fails to deploy, the Supabase project is paused, or pg_cron itself stalls, the whole system goes dark and **zero alerts fire**. It's the one failure mode that produces silence instead of a page — the worst kind, because "no alerts" reads identically to "all healthy."

**Why it matters ($ / signal):** this agent trades real (paper, en route to live) capital and its entire safety net is Telegram alerts. A silently-dead watchdog means a blown strategy, a stuck position, or a week of no trades could pass completely unseen — exactly the scenario the track record (the artifact gating the uncle-capital unlock) can least afford. Cheap to close.

**The one improvement — external heartbeat (dead-man's-switch):** on each successful `health-check` run, fire a heartbeat ping to an external uptime monitor that alerts *when the ping stops arriving* (inverted logic — the external service is the thing that can't be down at the same time as our infra). Concretely:
1. Create a free healthchecks.io (or Better Uptime / cron-job.org) check with a ~90-min period + grace, wired to Telegram/email.
2. Store its ping URL as a Supabase function secret `HEARTBEAT_URL`.
3. At the end of the `health-check` `try` block (after the run is logged), add a fire-and-forget `fetch(Deno.env.get("HEARTBEAT_URL"))` guarded by `.catch(() => {})` so it never affects the run. Ping only on success, so a crashing health-check also stops the heartbeat and trips the external alert.

**Where:** `supabase/functions/health-check/index.ts` (add the ping just before the final `return json({ ok: true, ... })`), plus one new function secret. ~5 lines of code + a 2-minute external-service setup. Rollback: remove the env var; the guarded fetch no-ops.

**Deeper fix (optional):** point the same external check at a lightweight `/functions/v1/kalshi-ping`-style liveness route too, so "can we still reach Kalshi with valid creds" is independently monitored from "is the watchdog alive."

---

## 2026-07-06 (health check, ~21:15 UTC) — Fix `daily-digest-cron`: it's been failing every night for a week (the only broken job in the fleet)

**Status:** Logged with ready-to-run fix — NOT applied (live-prod cron change = Hard Stop; Onofre not present this run). This is the **one live error on the Telegram feed** right now: `cron_failed: daily-digest-cron` fired 21:06:33 UTC — caught by the staleness watchdog that shipped 21:06 the same run.

**What Telegram showed / verified live:** `daily-digest-cron` is the **only** cron whose last run failed; the other 10 jobs all last ran `succeeded`. It has failed on **every** nightly run I can see — `cron.job_run_details` shows `status=failed` at 22:00 UTC on Jun 30, Jul 1, 2, 3, 4, 5 (six-plus consecutive nights, likely longer). The daily digest edge function has therefore **never actually been invoked by cron** — the digest has been silently dead for at least a week.

**Root cause (exact):** the job command builds the auth header by concatenating the Bearer token *inside a JSON string literal that is then cast to `::jsonb`*:
```
headers:='{"Content-Type":"application/json","Authorization":"Bearer " || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''SUPABASE_SERVICE_ROLE_KEY'')}'::jsonb
```
Postgres parses `{"...","Authorization":"Bearer " || (SELECT ...)}` as JSON *before* any SQL runs, and `||` is not valid JSON → `ERROR: invalid input syntax for type json … Token "|" is invalid`. The `||` concatenation is trapped in the literal instead of executing in SQL. Every other working cron (e.g. `surface-scanner-cron`) builds headers with `jsonb_build_object(...)`, so the concatenation happens in SQL — daily-digest is the lone outlier still using the broken inline-literal form.

**Why it matters ($ / signal):** the daily digest is the recurring P&L / performance recap — the ambient touchpoint that keeps the track record (the artifact gating the uncle-capital unlock) in front of Onofre daily. Broken = no digest for a week and 12-hourly `cron_failed` pages that erode trust in the alert channel. Low blast radius, one-call fix.

**The one improvement — ready to apply (awaiting go, Hard Stop):** rewrite the command to the proven `jsonb_build_object` pattern so the token concatenation runs in SQL, not inside a JSON literal:
```sql
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'daily-digest-cron'),
  command := $CMD$
  select net.http_post(
    url := 'https://uyfnezxmgwitpzsrnkst.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{}'::jsonb
  );
  $CMD$
);
```
Apply via the management API with `$SUPABASE_ACCESS_TOKEN_KTA` (same path used for the 20:47 weather-signal fix). Verify: next 22:00 UTC run lands `succeeded` (or trigger once manually to confirm before the nightly). Prereq check: confirm a `SUPABASE_SERVICE_ROLE_KEY` row exists in `vault.decrypted_secrets`; if not, fall back to the static-anon-`Bearer` + `apikey` header form that `surface-scanner-cron` already uses and works. Rollback: none needed — it's already 100% failing, so any change is strictly forward.

**Deeper fix (optional, not folded in):** daily-digest is the *only* job that fetches the key inline from vault; standardizing all edge-invoking crons to one shared, tested header-builder (or a `cron.schedule` helper) would remove this whole per-job-copy failure class.

---

## 2026-07-06 (health check, ~20:10 UTC) — Teach the health monitor to catch a *silently dead* cron (weather-signal was just parked to an impossible date)

**Status:** Logged — not applied. Telegram error feed is CLEAN this run (no error/alert rows since 19:10 UTC; the prior lesson_write + `.catch` fixes are holding). The one fresh finding is a **silent outage the monitor can't see**, below. No prod change made — restoring the cron is a live-prod change (Hard Stop; awaiting go).

**What I found (verified live):** `weather-signal-cron` ran cleanly every 10 min (`:04,:14,:24,:34,:44,:54`, all `succeeded`) through **17:54 UTC**, then stopped dead. Its schedule is now `59 23 31 2 *` — **minute 59, hour 23, day 31, month 2 = February 31st, a date that never occurs** — while `active = true`. So the job reads as healthy and will *never fire again*. Every other job in the fleet has a sane recurring schedule; weather-signal is the lone anomaly, which points to an accidental `cron.alter_job` (or an unlogged manual park) at ~17:54 UTC.

**Why it matters ($ / track record):** weather-signal feeds **Weather Edge (S-005)** — one of only two live trading strategies. Dead signal source → no new weather signals → S-005 stops trading → the track record (the artifact gating the uncle-capital unlock) accrues on half the fleet. And it's **invisible**: `active=true`, zero failures, so nothing alerts.

**Root-cause enabler (the actual improvement):** the health path — `agent_cron_health` view + `health-check` function — only flags **failed** runs (`failures_last_hour`). A job that stops scheduling entirely (parked to a never-date, or simply idle) shows `runs_last_hour=0, failures=0` and reads as green. The monitor is structurally blind to *silent death*, which is the failure mode that just happened. (Compounds the 2026-07-06 17:10 note that the view's `WHERE` also misses 5 of 11 jobs — daily-digest, auto-settle, market-data-fetcher, health-check, backtest-weather.)

**One improvement:** add **staleness detection** to the health check — for every active job, alert when `now() - last_started_at > K × expected_interval` (K≈3), independent of run status. This catches parked/never-date schedules, stalled jobs, and disabled-but-active jobs — the whole silent-death class — instead of only failed runs. Widen the view's `WHERE` to cover all 11 jobs at the same time.

**Immediate live fix — APPLIED 20:47 UTC (Onofre "continue"):** restored the schedule from `59 23 31 2 *` to its prior 10-min cadence `4,14,24,34,44,54 * * * *` via `cron.alter_job` (management API, `$SUPABASE_ACCESS_TOKEN_KTA`). Verified accidental first: at 18:05 UTC — after the 17:54 stop — S-005/Weather Edge was still evaluating live weather markets (KXHIGHLAX/NY/MIA-26JUL06), the strategy is `active`, weather markets are trading in-season, no compliance_log note explains the change, and every other job has a sane schedule → collateral from today's cron work, not an intentional disable. Fire-verified: 20:54:00 UTC run landed `succeeded`, and `weather_signal_run: 3/5 locations OK` logged at 20:54:02 → signal generation is live again (10-min cadence resumed). Rollback: re-park to `59 23 31 2 *`.

**The actual improvement — SHIPPED 21:06 UTC (Onofre "go and ship").** Staleness + failure detection now live in the health-check watchdog:
- Migration `20260706_cron_staleness_detection.sql`: `public.cron_health()` (`SECURITY DEFINER`, service_role-only) learns each job's real cadence from run history (median gap over 7d) and flags any active job overdue by >3× (`is_stale`) or whose last run failed (`last_run_failed`); rebuilt `agent_cron_health` view over it, widened from the old 6-of-11-job filter to **all 11 jobs**.
- `health-check/index.ts` §9: new `cron_stale` (6h cooldown) + `cron_failed` (12h, fingerprinted on the failed-run date) alerts; also alerts `cron_health_unavailable` if the RPC itself fails (watchdog stays loud). Deployed to `uyfnezxmgwitpzsrnkst`.

**Verified live:** `cron_health()` returns all 11 jobs with correct learned cadences (weather-signal 600s, hourly jobs 3600s, dailies 86400s) and zero false positives; invoking the deployed function returned `alerts_sent: ["cron_failed"]` — it caught `daily-digest-cron`'s failed run (previously invisible to the monitor) on the first run, dedup record logged at 21:06:33 UTC. Had this shipped this morning, weather-signal's park would have paged within ~30 min instead of running dark ~3h.

**Surfaced by the new detector (next fix, separate — not folded in):** `daily-digest-cron` is still broken (the JSON `||`-in-literal header bug from the 17:10 entry — fix SQL is there). It now pages every 12h until fixed. One `cron.alter_job` call closes it.

---

## 2026-07-06 (health check, ~19:10 UTC) — Guard the `trade_lessons` lesson_type constraint against code drift (root cause of this week's 3-hourly Telegram spam)

**Status:** Live error is RESOLVED — logging one guard to stop the class from recurring. No prod change made this run.

**What Telegram showed:** a single `lesson_write_error` for trade `2ae0d30e-fc43-4ddb-b0bc-bb61a64100e4` (ticker `KXHIGHNY-26JUL02-B99.5`, a NYC high-temp weather market) fired every ~3h from Jul 5 through **10:07 UTC Jul 6** — verified in `compliance_log` (`event_type=lesson_write_error`). Full DB error: `new row for relation "trade_lessons" violates check constraint "trade_lessons_lesson_type_check"`. The trade settled with a `stale_signal` lesson, but the DB CHECK constraint didn't include `stale_signal`, so every hourly `auto-reflect` retried the same insert, hit `23514`, re-logged, and re-alerted.

**Current state (verified live this run):** the constraint now accepts `stale_signal` and `kelly_mismatch` (probe inserts pass the check — only fail on FK/NOT-NULL), and the lesson row for the trade was **successfully written at 10:30:34 UTC**. No `lesson_write_error` has fired since 10:07 UTC. The alert spam is over; migration `20260706_trade_lessons_lesson_type_expand.sql` (untracked in repo) matches the now-live constraint.

**One improvement (this run):** add a **sync guard** so the DB `trade_lessons_lesson_type_check` allowlist can never again silently diverge from `validLessonTypes` in `auto-reflect/index.ts`. The code comment already names `validLessonTypes` as "the single source of truth… add it here too" — but that coupling is manual, and this week proved it fails silently for days. Two concrete forms, cheapest first:
- **Test guard (safe, no prod):** a unit test that asserts `validLessonTypes` (parsed from `auto-reflect/index.ts`) is a subset of the constraint's allowlist (parsed from the latest `trade_lessons_lesson_type_*` migration). Fails CI the moment a new lesson type is added to code without a matching migration.
- **Runtime backstop:** in `auto-reflect`, on a `23514` insert failure, fall back to `lesson_type = "general"` (already the LLM-unknown default) so a never-before-seen type degrades gracefully instead of poison-looping and alerting every cycle.

**Why it matters ($ / signal):** the learning loop is the product's moat (per CLAUDE.md — compounding shared memory). A lesson type that can't be written is a lost lesson *and* days of alert noise that trains Onofre to ignore the alert channel — the exact channel meant to surface a real outage. Low blast radius (a test + a one-line fallback), high value: closes the failure class instead of waiting for the next unlisted lesson type.

**To apply:** add the test under `supabase/functions/tests/` and the `23514`→`general` fallback at the lesson-insert site (`auto-reflect/index.ts` ~line 605). No deploy required for the test; the runtime fallback ships with the next `auto-reflect` deploy (Hard Stop — awaiting go).

---

## 2026-07-06 (health check, ~18:10 UTC) — Kill the remaining `.catch()`-on-Supabase-builder bugs (8 latent copies of the crash that just spammed Telegram)

**Status:** Fixed in repo (8 edits, branch `feat/strategy-stories`) — **not deployed** (edge-function deploy = live-prod Hard Stop; awaiting go). No commit made.

**One improvement (this run):** The `system_errors` Telegram alert fired every ~3h for days (last at 11:10 UTC, now quiet since ~10 UTC) because `auto-trade` chained `.catch()` directly onto a Supabase query builder — the builder is a thenable with **no `.catch` method**, so `x.catch is not a function` throws every time that line runs. The prior run fixed the two auto-trade copies (v137 @ 16:49 UTC). **The exact same anti-pattern still lives in 8 other spots**, each one a latent throw that turns an error-logging or dedup path into an unhandled crash the moment it's hit:

| File | Line | Path it breaks |
|------|------|----------------|
| `_shared/telegram.ts` | 67 | `alertOnce` dedup-record insert — a throw here defeats alert de-duplication (part of *why* alerts repeat) |
| `auto-reflect/index.ts` | 571, 710, 789 | lesson-LLM-fallback + lesson-loop-crash + memory-attribution error logs |
| `weather-signal/index.ts` | 292 | per-location ECMWF-failure log (fires on the 2/5 locations that fail each run) |
| `settle-signals/index.ts` | 87 | Kalshi API-error log |
| `auto-settle/index.ts` | 273 | weather-calibration `upsert` on the settle path |
| `daily-digest/index.ts` | 70 | digest compliance-record insert |

**Root cause:** inconsistent error-swallowing idiom. The codebase already has the correct form (`auto-trade` line 980: `.then(null, () => {})`) but these 8 sites used `.catch(fn)`, which only works on a real Promise, not the Postgrest builder. Fixed all 8 to `.then(undefined, fn)` — behavior-preserving (still fire-and-forget), matching the codebase's own working pattern. Repo scan now reports zero remaining builder-`.catch` sites.

**Why it matters ($ / signal):** these sit on the exact paths that are *supposed* to make failure visible — the alert-dedup record and every "log the error" branch. When the logger itself throws, the real failure is masked and, in `alertOnce`'s case, the de-dup breaks and Onofre gets spammed. Low blast radius (all fire-and-forget swallows), high hygiene value: it closes the bug class that caused this week's alert noise instead of patching one instance at a time.

**To ship (per project deploy protocol, `$SUPABASE_ACCESS_TOKEN_KTA`):** redeploy the 6 touched functions — `auto-reflect weather-signal settle-signals auto-settle daily-digest` (and any function importing `_shared/telegram.ts`, i.e. most of them). Verify after: no new `TypeError: … catch is not a function` in function logs across the next cron cycle. **Note:** branch `feat/strategy-stories` carries unrelated uncommitted work (DashboardHero, SettingsPanel, create-checkout, tests) from a prior session — do not blanket-commit; stage only these 8 fixes.

---

## 2026-07-06 (health check, ~17:10 UTC) — Fix the broken `daily-digest-cron` header (nightly digest has never fired)

**Status:** Logged — not applied (live-prod cron change; awaiting go). Fix is one management-API call, below.

**One improvement (this run):** `daily-digest-cron` (cron.job jobid 19, `0 22 * * *`) has been **failing on every run**. Its last run (2026-07-05 22:00 UTC) errored `invalid input syntax for type json … Token "|" is invalid`. It is the only cron job in the project not in `succeeded` state over the last 24h — every other job (signal-gen, auto-trade, surface-scanner, auto-settle, futures/weather signal, market-data-fetcher, auto-reflect, health-check) is green.

**Root cause (verified — read the live job command):** the job builds its auth header by putting a SQL `||` concatenation *inside* a JSON string literal, then casting the whole thing to `::jsonb`:
```sql
headers:='{"Content-Type":"application/json","Authorization":"Bearer " || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''SUPABASE_SERVICE_ROLE_KEY'')}'::jsonb
```
Postgres parses the literal as JSON *before* any concatenation runs, hits the `|`, and rejects it — so `net.http_post` is never even called. The digest edge function is fine; the cron wrapper never invokes it. The working `health-check-hourly` job (jobid 15) does it correctly with `jsonb_build_object(...)`.

**Why it matters ($ / signal):** the daily digest is the once-a-day rollup of the agent's trading activity to Onofre. It has silently sent nothing — so the one scheduled "is the agent doing its job?" summary never arrives, and a failure could hide unseen. Low blast radius (read-only summary), high value (restores daily visibility into the product that's meant to become the track record).

**Fix (apply via management API with `$SUPABASE_ACCESS_TOKEN_KTA`, mirroring jobid 15's pattern):**
```sql
SELECT cron.alter_job(19, command := $$SELECT net.http_post(
  url := 'https://uyfnezxmgwitpzsrnkst.supabase.co/functions/v1/daily-digest',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
  ),
  body := '{}'::jsonb
);$$);
```
Verify after: next 22:00 UTC run shows `succeeded` in `cron.job_run_details`, and the digest lands in Telegram.

**Also noted (not this run's pick):** the `agent_cron_health` view only surfaces 6 of the 11 active cron jobs — daily-digest, health-check, auto-settle, market-data-fetcher, and backtest-weather are absent, which is exactly why this failure went unseen. Worth widening the view to cover all jobs so the health monitor can't miss a dead cron.

---

## 2026-07-06 (health check, 16:10 UTC) — Ship the two pending fixes; correct `.env` project-ref drift blocking local deploys

**Status:** SHIPPED 16:49 UTC (Onofre "ship it"). **Correction after verifying live data:** both error streams had already gone quiet at ~10:07 UTC — a prior session had already applied both fixes ~10:00–10:30 (first-ever successful `stale_signal` lesson landed 10:30:34). The "still firing ~42×/day" in this entry was a 24h *cumulative* count, not a live rate; the "never had stale_signal" read came from a `limit=200` query that hit the row cap and missed it. So the migration + auto-trade redeploy below were **idempotent re-applications of an already-fixed state** (they lock it in: constraint verified to include `stale_signal`; auto-trade redeployed to v137 @ 16:49 UTC; S-001 `is_halted:false`, `consecutive_failures:0`). The **genuinely-new fix was #3 (the `.env`/`sync-env.sh` drift)** — that was still broken and is now corrected at the source.

**One improvement (this run):** The two recurring error streams below already have fixes authored *in the repo* — they were never shipped to the live project (`uyfnezxmgwitpzsrnkst`), so they keep firing. Deploy them:
1. **`lesson_write_error` (19×/last 24h)** — fix migration `supabase/migrations/20260706_trade_lessons_lesson_type_expand.sql` widens `trade_lessons_lesson_type_check` to include `stale_signal`; live DB still only holds `general/signal_quality/market_timing/forecast_bias`, confirming it was never applied. Apply via the management API (`$SUPABASE_ACCESS_TOKEN_KTA`), **not** `db push`.
2. **`auto_trade_strategy_error` (23×/last 24h)** — deployed `auto-trade` crashes at its line 1016 (`.catch is not a function`) in `runS001SurfaceArb`, so S-001 surface-arb does **zero trades** every run. Local source already carries the safe `.then(null, …)` pattern — the function was just never redeployed. `supabase functions deploy auto-trade --project-ref uyfnezxmgwitpzsrnkst`.

**Newly found root enabler (verified this run):** backend `.env` has `SUPABASE_URL=https://iuxuogwqchrozsqclvgx.supabase.co` — the **wrong project**. Live ref is `uyfnezxmgwitpzsrnkst` (matches `.claude`/`config.toml`/frontend `VITE_SUPABASE_URL`). `SUPABASE_SERVICE_KEY` in `.env` is also empty (stale-env warning). Any local backend script silently targets a dead/wrong project. Fix: rerun `~/sync-env.sh`, set `SUPABASE_URL` to the live ref.

**Impact if shipped:** clears ~42 false/real Telegram alerts/day, unjams the learning flywheel (the moat), and revives an entire trading strategy (S-001). Verify after deploy: zero new `lesson_write_error` / `auto_trade_strategy_error` rows in `compliance_log` over the next 2–3 cron cycles.

---

## 2026-07-06 (health check) — Fix `trade_lessons_lesson_type_check` schema drift blocking the learning loop

**Status:** Logged — not yet fixed/deployed (live-prod schema change is a Hard Stop; awaiting go).

**What Telegram is reporting (still active, latest fire 2026-07-06 11:10 UTC):**
- `system_errors` / `lesson_write_error` — `Failed to write lesson for trade 2ae0d30e… (KXHIGHNY-26JUL02-B99.5): new row for relation "trade_lessons" violates check constraint "trade_lessons_lesson_type_check"` (Postgres `23514`). Re-fires roughly hourly via auto-reflect, then again on the ~3h health-check sweep. **80 failed attempts since Jul 1, all one permanently-stuck trade.**

**Root cause (verified):** code/DB enum drift. `auto-reflect/index.ts:458` defines `validLessonTypes = ["forecast_bias","market_timing","stale_signal","kelly_mismatch","signal_quality","execution","market_structure","general"]` and validates the LLM output against it (line 554). But the DB `trade_lessons_lesson_type_check` CHECK constraint was never widened to match — it rejects `stale_signal` (and presumably `kelly_mismatch`, `market_structure`, `execution`). The LLM classified this loss as `stale_signal`, code accepted it, Postgres rejected the INSERT. The trade never gets reflected, so every auto-reflect cycle re-picks it, re-fails, and re-alerts — forever.

**Why it matters ($ / moat):** the learning loop *is* the moat (trades → lessons → agent_memory → better returns). A trade stuck unreflected means that lesson never reaches memory, and any future trade the LLM labels with one of the missing types will jam the same way. It also floods Telegram, burying real alerts.

**Fix (defense in depth):**
1. **Widen the DB constraint** to match the code enum:
   ```sql
   ALTER TABLE trade_lessons DROP CONSTRAINT trade_lessons_lesson_type_check;
   ALTER TABLE trade_lessons ADD CONSTRAINT trade_lessons_lesson_type_check
     CHECK (lesson_type IN ('forecast_bias','market_timing','stale_signal',
       'kelly_mismatch','signal_quality','execution','market_structure','general'));
   ```
2. **Colocate the source of truth** — derive the constraint and `validLessonTypes` from one shared list so they can't drift again (the recurring "schema drift" failure mode).
3. **Backfill:** re-run auto-reflect for trade `2ae0d30e-fc43-4ddb-b0bc-bb61a64100e4` once the constraint is fixed so its lesson lands.

**Verification plan before shipping:** apply the migration via `SUPABASE_ACCESS_TOKEN_KTA`, re-trigger auto-reflect, confirm the stuck trade writes a lesson and zero new `lesson_write_error` rows appear in `compliance_log` over the next few cycles.

---

## 2026-07-06 — Fix systemic `.catch()`-on-Supabase-builder bug crashing strategies

**Status:** Logged — not yet fixed/deployed (production deploy is a Hard Stop; awaiting go).

**What Telegram was reporting (last 7 days, still active as of 2026-07-06 10:05 UTC):**
- `auto_trade_strategy_error` — `Strategy "Surface Arbitrage" failed: supabase.from(...).update(...).eq(...).catch is not a function` and `Strategy "Weather Edge" failed: supabase.from(...).insert(...).catch is not a function`. Fires on nearly every 5-min auto-trade run.
- `lesson_write_error` — separate, secondary issue: a `trade_lessons_lesson_type_check` constraint violation for trade `2ae0d30e…` (`KXHIGHNY-26JUL02-B99.5`) retried hourly by auto-reflect. Tracked but not this entry's fix.

**Root cause (verified):**
`@supabase/supabase-js@^2.99.1` query builders are `PromiseLike` — they implement `.then()` but **not** `.catch()`/`.finally()`. Calling `.catch()` directly on a builder (`supabase.from(x).insert(y).catch(...)`) throws `TypeError: catch is not a function` at runtime, which propagates up and crashes the calling strategy before/after its trade logic. Code that uses `.then().catch()` or `await` in try/catch works; the bare `.catch()` variant never has.

**Scope — systemic, 9 occurrences across edge functions:**
- `supabase/functions/auto-reflect/index.ts` (~571, ~710, ~789)
- `supabase/functions/auto-settle/index.ts` (~273 — weather calibration upsert, runs on every live settlement)
- `supabase/functions/weather-signal/index.ts` (~285 — Kalshi api_error path → Weather Edge)
- `supabase/functions/daily-digest/index.ts` (~70)
- `supabase/functions/execute-trade/index.ts` (~208)
- `supabase/functions/settle-signals/index.ts` (~87)
- `supabase/functions/_shared/telegram.ts` (~67 — the dedupe insert in `alertOnce`)

**Why it matters ($ / revenue):** these are the two live-trading strategies (Surface Arbitrage, Weather Edge) failing on nearly every run — no track record accrues while they crash, and the track record is the artifact gating the uncle-capital unlock. It also floods Telegram hourly, training us to ignore real alerts.

**Fix:** replace every bare `.catch()` on a Supabase query builder with `await` inside try/catch, or `.then(onOk, onErr)` / `.then().catch()`. Add a lint rule (or grep guard in CI) to block `.catch(` chained on a `from(...)` builder so it can't recur.

**Verification plan before shipping:** deploy the affected functions with `SUPABASE_ACCESS_TOKEN_KTA`, then confirm zero new `auto_trade_strategy_error` rows in `compliance_log` over the next few auto-trade runs.

---

## 2026-07-09 — Surface-scan `warning` threshold fires on 100% of scans → buries real alerts

**Status:** Logged — not yet fixed/deployed (production deploy is a Hard Stop; awaiting go). Found via scheduled health check.

**Health snapshot (Telegram / `compliance_log`, last 7 days):**
- The two systemic bugs from 07-06 (`auto_trade_strategy_error` from the bare-`.catch()` TypeError, and `lesson_write_error` from the `trade_lessons` constraint) **stopped firing after 2026-07-06 ~11:10 UTC** — appears resolved by the auto-trade deploy on 07-08. No occurrences since.
- Only genuinely *new* errors: a burst of transient `api_error` — `market-data-fetcher: Kalshi 503 on series KXHIGHNY/LAX/AUS (after retries)` at 2026-07-09 07:36–08:10 UTC. Upstream Kalshi 503s, self-recovered; health-check correctly deduped one alert. External/transient, no code fix needed.

**The finding (severity misclassification):**
`surface-scanner/index.ts:450` sets severity as `filteredAlerts.some(a => a.expected_edge_cents >= 10) ? "warning" : "info"`. That condition is true on **1000 of 1000** scan-complete rows in the last 7 days — the scanner runs every ~5 min (~288/day) and *every single run* logs at `warning`. The threshold is effectively a constant, so the `warning` severity carries no signal: genuine warnings (`health_check_alert` for Kalshi 503, `trading_silence`, `system_errors`) are drowned in ~288 routine "scan found N alerts" rows per day. This is the exact alert-fatigue failure the 07-06 entry flagged ("floods Telegram... training us to ignore real alerts").

**Root cause:** a `>= 10¢` edge is not a rare/notable event for this scanner — it's the baseline. Either the edge calc is optimistic (10¢+ "edge" on essentially every sweep, yet `trading_silence` still fired on 07-06 → detections aren't converting to trades), or the threshold is simply miscalibrated for an alert-worthy line.

**Fix (proposed):** downgrade routine `surface_scan_complete` to `info` and reserve `warning` for a genuinely rare condition — e.g. raise the edge bar well above baseline (percentile-based, or ≥25–30¢) and/or require a minimum count of high-edge alerts. Reserve the `warning` channel for actionable states so real alerts surface. Secondary follow-up: investigate why 10¢+ detections on every scan don't convert to trades (scanner↔trade-path disconnect).

**Verification plan before shipping:** after the severity change, confirm `surface_scan_complete` rows log at `info` on normal sweeps and that `warning` rows drop to a handful/day corresponding to genuine high-edge events; confirm real `health_check_alert` warnings are no longer buried.

---

## 2026-07-09 (2nd) — Transient Kalshi 5xx logged at `error` → pages Onofre for self-healing blips

**Status:** Logged — not yet fixed/deployed (production deploy is a Hard Stop; awaiting go). Found via scheduled health check.

**Health snapshot (live `compliance_log`, last 3 days):** 1000 rows — 684 `info`, 312 `warning`, **4 `error`**. All 4 errors are the same event: `market-data-fetcher: Kalshi 503 on series KXHIGHNY/LAX/AUS (after retries)` at 2026-07-09 07:36–07:41 UTC. Fully self-recovered by the next ~5-min scan; no `error` rows before or since. Two `health_check_alert` rows fired off them (`api_error_kalshi:503` + `system_errors`) → Onofre was paged for a transient upstream outage.

**The finding (severity misclassification → false page):**
`market-data-fetcher/index.ts:113` sets `severity: is429 ? "warning" : "error"`. A 429 (rate limit) is correctly downgraded to `warning`, but **every other non-200 — including transient upstream 502/503/504 — logs at `error`.** Health-check (`health-check/index.ts:254`) sweeps `severity IN ('error','critical')` over the last 2h and fires the `system_errors` Telegram alert. Net effect: a single 5-min Kalshi 503 blip that self-heals on the next scan pages Onofre at `error` severity — the same alert-fatigue failure mode flagged on 07-06 and in the 07-09 (1st) entry, now on the inbound-data path.

**Root cause:** a one-off upstream 5xx is a transient, self-correcting condition (like a 429), not a code fault or sustained outage — but it's classified as `error` purely because it isn't a 429. Severity is keyed off the specific status code, not off whether the condition is transient-and-recovered vs. sustained.

**Fix (proposed):**
1. Treat transient upstream 5xx (502/503/504) like 429 — log the single-cycle failure at `warning`, not `error`, so it doesn't trip the `system_errors` page.
2. Add a **consecutive-failure gate**: escalate a series to `severity: error` + page only after it fails N consecutive scans (e.g. ≥3 cycles ≈ 15 min), i.e. a real sustained outage rather than a blip. Track a per-series consecutive-fail counter (KV or a small `market_data_health` row) that resets on the first success.
3. Keep `429` handling as-is (already `warning`).

**Why it matters:** the inbound market-data path is the one that must page loudly on a *real* Kalshi outage (no data → no trades). Paging on self-healing blips trains us to mute exactly the channel that needs to stay trustworthy. The consecutive-failure gate preserves the loud page for genuine outages while killing the false ones.

**Verification plan before shipping:** after the change, confirm single-cycle Kalshi 5xx blips log at `warning` and fire no `health_check_alert`; simulate/observe ≥3 consecutive failures on a series and confirm it escalates to `error` + one deduped page; confirm a real sustained outage still pages within ~15 min.

---

## 2026-07-09 (3rd) — `market-data-fetcher` Kalshi timeout mislabeled `api_error_unknown` on the page

**Status:** Logged — not yet fixed/deployed (production deploy is a Hard Stop; awaiting go). Found via scheduled health check.

**Health snapshot (live `compliance_log`, last ~26h — the 1000-row window only spans 07-08 17:36 → 07-09 19:08 UTC because `surface_scan_complete` still floods it):** 680 `info`, 316 `warning`, 4 `error`. The 4 `error` rows are the already-logged self-healing Kalshi 503 blip (07-09 07:36–07:41 UTC, entry "07-09 (2nd)"). One new page today: `health_check_alert: api_error_unknown` at 18:10 UTC, fingerprint `api_error_unknown:api_timeout`.

**The finding (provider misclassification → uninformative page):**
The 18:10 page was fired off a single `api_timeout` warning at 17:41 UTC — `market-data-fetcher: request timeout on series KXFED (>8000ms)`, metadata `{"series":"KXFED","timeout_ms":8000}`. In `health-check/index.ts`, `extractProvider()` (~278) keys off `metadata.provider` / `metadata.endpoint` / `metadata.full_path`, then a `kalshi` substring in the message. This row has none of those — no `provider`, no `endpoint`, and the message string says "market-data-fetcher … series KXFED" with no "kalshi" token — so it falls through to `return "unknown"`. Onofre's page read **"🔴 [TradeAgent] UNKNOWN api_timeout: 1x in 2h"**, which names no cause. But `market-data-fetcher` only ever calls Kalshi (`market-data-fetcher/index.ts:173–175` emits this event), so the timeout is unambiguously Kalshi's — the "unknown" label is pure signal loss on the alert that matters most (inbound data path).

**Root cause:** `extractProvider` recognizes a provider only via `metadata.provider/endpoint` or a literal "kalshi" substring. The market-data path logs neither — it tags the row with the Kalshi *series ticker* (`KX…`) and a `market-data-fetcher:` message prefix, neither of which the classifier maps to `kalshi`. Provider inference is coupled to fields this emitter doesn't set.

**Fix (proposed):**
1. In `extractProvider`, map the market-data origin to Kalshi: treat a `market-data-fetcher` message prefix, or a `metadata.series` / message matching `/^KX/`/`/\bKX[A-Z]/`, as `provider = "kalshi"`. (Kalshi series tickers are all `KX*`.)
2. Better still, fix at the source: have `market-data-fetcher/index.ts` write `metadata.provider = "kalshi"` on the `api_timeout` (and `api_error`) rows it logs, so the classifier never has to infer. Cheapest durable fix; one field on the insert.
3. Do both — (2) prevents recurrence for this emitter, (1) backstops any other Kalshi-series emitter that forgets the field.

**Why it matters ($ / revenue):** the inbound market-data path is the one alert channel that must stay legible — no data → no trades → no track record (the artifact gating the uncle-capital unlock). A page that says only "UNKNOWN" forces a manual dig every time and erodes trust in the exact channel that must page loudly on a real Kalshi outage. This is provider-labeling, distinct from the "07-09 (2nd)" severity fix; the two compose (correct provider + transient-vs-sustained gate = one accurate, actionable page).

**Verification plan before shipping:** after the change, re-run health-check against the 17:41 KXFED timeout (or a synthetic `api_timeout` with `metadata.series="KXFED"`) and confirm the alert type/fingerprint resolve to `api_error_kalshi` / `api_error_kalshi:api_timeout` and the page text reads "KALSHI", not "UNKNOWN"; confirm non-Kalshi emitters still classify correctly.

---

## 2026-07-10 — `auto-settle` writes a heavy `info` row every ~10 min on no-op runs → floods the observability window

**Status:** Logged — not yet fixed/deployed (production deploy is a Hard Stop; awaiting go). Found via scheduled health check.

**Health snapshot (live `compliance_log`):** last 3 days — 1000-row window, 0 `critical`, **4 `error`** (all the already-logged self-healing Kalshi 503 blip from 07-09 07:36–07:41 UTC, entry "07-09 (2nd)"; nothing new). Pages since 07-06: `system_errors` ×4 and `trading_silence` ×2 (all 07-06, since resolved) plus the two 07-09 pages already logged; today's only page is `trading_silence` (fingerprint `silence_day_2026-07-10`, 03:10 UTC — daily paper-mode quiet-day notice, expected). **No new error class.** The finding is a log-hygiene one surfaced by the event-type distribution.

**The finding (no-op runs log at full detail → crowd out the observability window):**
`auto_settle_run` is now the single largest emitter into `compliance_log` — **204 runs in the last 24h, and 0 of them settled anything** (every row reads `auto-settle: 0 trades settled across 0 tickers, N still pending`). The terminal insert at `auto-settle/index.ts:429` fires on *every* run at `severity: "info"` regardless of outcome, and stuffs the full per-ticker `results` array into `metadata` (`{ run_id, started_at, results }`) — so each no-op run writes a heavy row every ~10 min. Combined with the `surface_scan_complete` flood already flagged (07-09 1st), the rolling 1000-row `compliance_log` window now spans well under two days, which is exactly the window `health-check` and any manual review read from. Same root cause as the surface-scan finding — routine success logged at `info` with a full payload — on a different, higher-frequency emitter.

**Root cause:** the settle path treats "ran, nothing was due to settle yet" (the overwhelmingly common case — trades are open until their market resolves) as a loggable event at the same severity and payload weight as "settled trades." Log volume is keyed off *that the run happened*, not off *whether it did anything*.

**Fix (proposed):**
1. On a no-op run (`totalSettled === 0` and no voids/errors), skip the terminal `compliance_log` insert entirely — or write a single lightweight `debug`/`info` heartbeat with `metadata: { run_id }` only, dropping the `results` array. Reserve the full-detail `auto_settle_run` row for runs that actually settled or voided something.
2. Drop the redundant start-of-run "no pending trades" insert at `auto-settle/index.ts:86` to the same lightweight treatment (it's a second no-op info row per empty run).
3. Keep the `error` path (`:452`) and the per-void/settle rows loud and full-detail — those are the events worth retaining.
4. Compounds with the 07-09 (1st) `surface_scan_complete` downgrade: together they restore the `compliance_log` window to spanning days, not hours, so real `warning`/`error` events stay visible to health-check.

**Why it matters:** the `compliance_log` window is the system's memory for both the automated health-check sweep and any manual audit — the track-record/observability artifact that gates the uncle-capital unlock. Filling ~400 rows/day with identical "settled nothing" payloads pushes genuine warnings and errors out of the 1000-row window faster, degrading exactly the record that must stay legible. No trading behavior changes — this is pure signal-to-noise on the audit trail.

**Verification plan before shipping:** after the change, confirm no-op auto-settle runs write at most one lightweight row (or none) with no `results` payload; confirm a run that actually settles/voids a trade still logs a full-detail `auto_settle_run` row; confirm the `error` path still logs at `error`; re-pull the 3-day `compliance_log` window and confirm it spans meaningfully longer (fewer auto_settle_run + surface_scan_complete rows crowding it).


## 2026-07-10 (2nd) — Root-cause: no shared compliance-log helper → routine "run OK / no-op" rows logged at `info` per-emitter, and `market_data_fetch` (288/day) is the last big emitter still unpatched

**Status:** Logged — not yet fixed/deployed (production deploy is a Hard Stop; awaiting go). Found via scheduled health check.

**Health snapshot (live `compliance_log`):** last 3 days — 0 `critical`, **4 `error`** (all the same self-healing Kalshi 503 blip from 07-09 07:36–07:41 UTC on series KXHIGHNY/LAX/AUS, already logged as "07-09 (2nd)"; nothing new). Pages: today's only page is `trading_silence` (07-10 03:10 UTC — deduped to once/day, expected in paper mode); 07-09 had `api_error_kalshi` + `system_errors` + `api_error_unknown`, all already logged. Trades are flowing (6 `order_filled`, 6 `trade_settled` in 24h). **No new error class through Telegram** — the inbound alert channel is clean.

**The finding (systemic, not another single-emitter instance):** the last two health checks each patched one noisy emitter — `surface_scan_complete` (07-09 1st) and `auto_settle_run` (07-10 1st). The reason there's always another one is that **there is no shared compliance-log writer** — `_shared/` has `telegram.ts`, `sentry.ts`, `risk.ts`, etc., but no `logCompliance()`. Every edge function calls `supabase.from("compliance_log").insert({...})` inline and independently decides its own severity and payload weight. So the "log routine success/no-op quietly" rule has to be re-applied by hand in each function, and any new emitter repeats the mistake by default.

The still-unpatched emitter that proves it: `market-data-fetcher/index.ts:221` writes a terminal `market_data_fetch` row on **every** run at `severity: "info"` with a full metadata payload — **288 rows/24h**, tied for the single largest emitter in the window. Together with the two already-flagged emitters, ~720 routine info rows/24h (`market_data_fetch` 288 + `surface_scan_complete` 288 + `auto_settle_run` 144) still crowd the rolling 1000-row window that `health-check` and manual audits read from.

**Root cause:** logging severity/volume is a per-emitter decision with no single chokepoint, so the noise-gating policy can't be enforced in one place — it drifts, and every fix is local and temporary.

**Fix (proposed):**
1. Add `_shared/compliance.ts` exporting `logCompliance({ event_type, severity, message, metadata, routine? })`. When `routine: true` and `severity === "info"`, drop to a lightweight `debug`/heartbeat row (`metadata: { run_id }` only, no full payload) or skip entirely — one implementation of the gating rule.
2. Route `market_data_fetch` (`market-data-fetcher:221`), and the already-identified `surface_scan_complete` and `auto_settle_run` terminal inserts, through it with `routine: true` on the clean-run path; keep the `warning`/`error`/`critical` branches loud and full-detail.
3. Migrate the remaining inline `compliance_log` inserts to the helper opportunistically so future emitters inherit the policy for free.

**Why it matters ($ / revenue):** the 1000-row `compliance_log` window is the system's audit memory for both the automated health sweep and any manual review — the observability/track-record artifact that gates the uncle-capital unlock. Patching emitters one at a time means the window keeps getting re-flooded by whichever emitter wasn't touched yet; centralizing the rule ends the recurrence and lets real `warning`/`error` events survive in the window for days, not hours. No trading behavior changes — pure signal-to-noise on the audit trail.

**Verification plan before shipping:** after adding the helper and routing the three emitters, re-pull the 24h `event_type` volume and confirm `market_data_fetch`/`surface_scan_complete`/`auto_settle_run` info rows drop to ~1 heartbeat per run (or zero) with no full payload; confirm a failed/partial market-data run still logs at `warning` with detail; confirm the 3-day window now spans meaningfully longer; confirm no error/critical path lost detail.


## 2026-07-10 (3rd) — `surface_scan_complete` escalates routine "found an edge" scans to `warning` → the warning tier is 97.8% noise

**Status:** Logged — not yet fixed/deployed (production deploy is a Hard Stop; awaiting go). Found via scheduled health check.

**Correction to prior entries (07-09 1st / 07-10 1st & 2nd):** those treated `surface_scan_complete` as an *info*-tier flood. Live data says otherwise — it emits at **`warning`**. Root: `surface-scanner/index.ts:450` sets `severity: filteredAlerts.some(a => a.expected_edge_cents >= 10) ? "warning" : "info"`. Finding a ≥10¢-edge alert is the scanner's *normal successful outcome* (finding edges is the entire job), so essentially every 5-min scan trips the warning branch.

**Health snapshot (live `compliance_log`):**
- `surface_scan_complete` over the last 1000 rows of that event: **1000/1000 at `warning`** — the `info` branch effectively never fires.
- Whole warning tier, last 500 warning rows: **489 `surface_scan_complete`** (97.8%), 4 `health_check_alert`, 3 `health_check_run`, 3 `market_data_fetch`, 1 `api_timeout`. The genuinely actionable warnings — `health_check_alert`, `api_timeout`, `cache_stale` — are 1–2% of the tier.
- **No new error/critical class through Telegram:** last error/critical rows are the self-healing Kalshi 503 blip from 07-09 07:36–07:41 UTC (already logged as "07-09 (2nd)"); the 07-06 `.catch is not a function` / `trade_lessons_lesson_type_check` errors have not recurred since 07-06. Inbound alert channel is clean.

**Root cause:** severity is keyed to *whether the scan found a tradeable edge*, not to *whether anything is wrong*. A successful scan that does its job is the trigger for `warning`. That inverts the severity contract — `warning` is supposed to mean "a human/health-check should look," and here it means "the scanner worked." This is distinct from the info-noise entries: it corrupts the higher-signal tier, so it degrades triage worse than an equivalent info flood.

**Fix (proposed, one line):** at `surface-scanner/index.ts:450`, log `surface_scan_complete` at `info` unconditionally (it is a routine completion regardless of how many edges were found), and route it through the proposed `_shared/compliance.ts` `logCompliance({ routine: true })` helper from entry 07-10 (2nd) so the payload is a lightweight heartbeat. Reserve `warning` for genuine anomalies that already have their own event types — `cache_stale` (`:365`), `surface_scanner_error` (`:494`). If a large edge is worth surfacing on its own, give it a dedicated event_type (e.g. `high_edge_detected`) rather than overloading the scan-complete row's severity.

**Why it matters ($ / revenue):** the `warning` tier is the first thing both the automated health sweep and any manual audit triage on — it's the "something needs attention" band. At 97.8% routine noise it's functionally dead: a real degradation (stale market cache, a genuine api_timeout) sits 1-in-50 and gets skimmed past. This is the observability/track-record artifact that gates the uncle-capital unlock; a warning tier nobody can trust is worse than no warning tier. One-line severity fix, zero trading-behavior change.

**Verification plan before shipping:** after the change, re-pull the last 500 `warning` rows and confirm `surface_scan_complete` no longer appears there; confirm scans still write an `info` `surface_scan_complete` heartbeat; confirm `cache_stale` / `surface_scanner_error` still emit at `warning`/`error`; confirm `health_check_alert` and `api_timeout` are now a visible fraction of the warning tier.
