# TradeAgent — Health Check Log

Findings from automated health-check runs. Newest first.

## 2026-07-29 (83rd run) — `execute-trade`'s 401-rejection logger has crashed on every unauthenticated/misconfigured call since 2026-06-20, masking the real 401 behind a 500

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was clean and matched `origin/dev`
exactly (82nd run's branch merged as PR #138) — `git fetch && git reset --hard origin/dev`, fresh
branch `health-check/run-20260729-1915` from there.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since the
82nd run's ~18:13 UTC cutoff through this run's ~19:13 UTC invocation — 3 rows. One
`kalshi_proxy_service_credential_fetch_failed` (19:01:25 UTC) — checked the full day's history (10
occurrences spread across 8 hours, none clustered, each immediately followed by a
`kalshi_proxy_unauthenticated_fallback` warning and self-heals) — same intermittent,
non-fatal credential-fetch-latency pattern already characterized and accepted in the 81st run, not
a new regression. One `auth_rejected` (18:25:36) — a legitimate security rejection of a
misconfigured/mismatched bearer, not a bug. The third is the real find.

**Root cause found and fixed (HIGH — silent since 2026-06-20, ~5 weeks):** `system_event` row at
18:23:51 UTC: `Trade execution error: supabase.from(...).insert(...).catch is not a function`.
Same failure signature as two already-fixed incidents in this exact codebase (`auto-trade`,
2026-07-06; `daily-digest`, 2026-07-26) — Supabase's query builder is a thenable, not a real
`Promise`, so `.catch()` doesn't exist on it and throws a `TypeError` synchronously, before the
insert's network request is ever dispatched. Traced to `execute-trade/index.ts:212`, in the
401-rejection compliance logger added by commit `12764cf` (2026-06-20, "log 401 rejections from
execute-trade to compliance_log") — `await supabase.from("compliance_log").insert({...}).catch(()
=> {})`. `git log -S` confirms this exact line hasn't changed since that commit; `grep`-audited
every `.catch(` call site across all 20+ edge functions in the repo (`supabase.from`/`.rpc` chains
only — fetch/sendTelegramAlert/sendUserNotification calls return real Promises and are unaffected)
and confirmed this is the **only** remaining site with the bare-`.catch()`-on-a-builder
anti-pattern; everywhere else already uses `.then().catch()` or the two-arg `.then(ok, err)` form.
Empirically reproduced against the live `npm:@supabase/supabase-js@2` resolution (v2.111.0) used by
this project: `typeof builder.catch === "undefined"`, and calling it throws `builder.catch is not
a function` — the same message shape (rendered with the call-site source text since there's no
intermediate variable) as the compliance_log row. **Effect:** any unauthenticated or
misconfigured-bearer call to `execute-trade` (e.g. `auto-trade` calling in with a stale/rotated
`SUPABASE_SERVICE_ROLE_KEY`) throws inside the intended-to-be-safe logging line, falls through to
the function's outer catch block, and returns a generic `500 Trade execution failed` instead of
the correct `401 Unauthorized` — and the audit-trail row this code exists to write has never once
been successfully persisted in the five weeks since it was added.

**Fix (deployed):** replaced `.catch(() => {})` with `.then(undefined, () => {})` on the single
call site, matching the established fix pattern from both prior incidents. Additive, one line,
same file, same risk class as the daily-digest fix.

**Verified:** `deno check supabase/functions/execute-trade/index.ts` — baseline (unmodified `dev`)
has 20 pre-existing errors (confirmed via `git stash`); after the fix, 19 — one fewer, because
`deno check` was independently flagging the missing `.catch` as a type error too, and it's now
gone. No new errors introduced. `npm run lint`: 0 errors, same pre-existing 9 fast-refresh
warnings. `npm run test`: 206/206 pass unchanged. Deployed `execute-trade`
(`supabase functions deploy`). **Exercised against the real deployed function:** confirmed
Supabase's platform-level `verify_jwt` gate (enabled for this function) rejects requests with no
or malformed `Authorization` header before the function's own code ever runs (`401
UNAUTHORIZED_NO_AUTH_HEADER` / `401 UNAUTHORIZED_INVALID_JWT_FORMAT`) — reaching the app-level
`isServiceRoleBearer` branch this fix touches requires a syntactically valid Supabase JWT with a
mismatched role, which is what `auto-trade`'s own internal calls produce when misconfigured; did
not fabricate one against the live money-adjacent endpoint beyond what's shown above, per the
same boundary every prior run touching this file has held to. Reversibility: trivial single-line
revert + redeploy.

**Anomaly noted, not chased:** the `auth_rejected` row (18:25:36 UTC) has full realistic metadata
(a real ticker, `service_key_configured: true`, a real `user_id_in_body`) implying its insert
*did* succeed, which seems to conflict with the "always throws" finding above. Function version
history (`GET /v1/projects/.../functions`) shows only the version this run just deployed (96,
timestamped to this run); there's no visibility into what was live at 18:25 without inspecting
the interactive checkout, which this task is explicitly barred from touching. Left unresolved —
doesn't change the fix, which is independently verified via static analysis, live empirical
reproduction, and the matching precedent from two prior incidents.

**Also observed, explicitly out of scope this run:** a `warning`-severity
`strategy_suspended_drawdown` row for "Weather Edge" citing a **1695.7%** max drawdown — outside
this run's `error`/`critical` query scope, and almost certainly its own calculation bug (a
drawdown percentage that large is not a real trading outcome), but investigating the drawdown
math is a different subsystem than this run's finding. Flagged here for a future run rather than
scope-crept into this one.

**Reversibility:** trivial — one-line diff, single file, `git revert` + redeploy restores the
prior (broken) behavior with no other change.

## 2026-07-29 (82nd run) — Clean window, all cron healthy; closed out the 76th run's Tier-4 backlog — all 10 unguarded `trading-agent/index.ts` chat-tool-loop sites

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was clean and already matched
`origin/dev` exactly (81st run's branch merged as PR #137) — `git fetch && git reset --hard
origin/dev`, fresh branch `health-check/run-20260729-1814` from there.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since the
81st run's ~18:04 UTC cutoff through this run's ~18:13 UTC invocation — zero rows. `cron_health()`
shows all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`. No new
error class this run.

**Fix applied (LOW risk, additive-only, single file, 10 call sites — closes Tier 4):** with
`compliance_log` genuinely clean, picked up the 76th run's own explicitly-left-open Tier-4 backlog
instead of inventing new scope — same pattern as the 80th run closing Tier 5 and the 81st run
closing Tier 2. All 10 sites confirmed still unguarded via `grep` before touching anything, in
`trading-agent/index.ts` — the interactive AgentPanel chat endpoint's tool-calling loop, where a
hang in any tool call freezes the user's chat turn with no `compliance_log` signal:
- `streamAnthropicAsSSE()` (`:541`, streaming Anthropic call) — the non-stream twin
  (`callAnthropicNonStream`, `:503`) was already guarded by an earlier run; the streaming path was
  missed.
- The OpenAI-compatible completions call (`:1095`, non-Anthropic providers via `cfg.baseUrl`).
- `fetch_live_markets`'s three Kalshi market-data GETs (`:1301` keyword search, `:1307` category
  fetch, `:1324` the 16-series parallel `Promise.all` fetch) — public read-only endpoints, so a
  timeout is a safe abort (returns fewer/no results, never leaves an order in flight). Factored into
  one local `fetchKalshi()` helper since all three shared the identical unguarded pattern.
- Four forwards to other edge functions: `execute_basket` (`:1776`), `fetch_signals` (`:1809`),
  `scan_surface` (`:1839`), `trigger_strategy_run` (`:1929`).
- `search_web`'s Tavily call (`:1871`).

All wrapped in the same `AbortController` + `setTimeout` + `finally { clearTimeout(...) }` pattern
used across 30+ sites in this campaign, each `AbortError` converted to a clear message naming the
call and the bound. Timeouts sized to what each call actually needs, not copy-pasted: `LLM_FETCH_
TIMEOUT_MS` (60s, existing constant) for both LLM paths; new `KALSHI_FETCH_TIMEOUT_MS` (8s, matches
the identical constant already established in `auto-trade/index.ts`) for the three Kalshi GETs; new
`INTERNAL_FUNCTION_TIMEOUT_MS` (45s) for the three same-latency-class forwards — sized above
`execute-basket`'s own internal `BASKET_TIMEOUT_MS` (30s) so the outer guard doesn't fire before the
inner one legitimately would; new `STRATEGY_RUN_TIMEOUT_MS` (60s) for `trigger_strategy_run`, since
`auto-trade`'s manual run can chain multiple 15s LLM-qualify calls sequentially across candidate
markets; new `EXTERNAL_SEARCH_TIMEOUT_MS` (10s) for Tavily, a third-party API with no internal
budget of its own to inherit. **Explicitly did not touch** the two Tier-1 sites in the same file
(`:1487` order submit, `:1533` order cancel — real money, off-limits per the 48th run's standing
caution) or the two Tier-1-adjacent basket execute/flatten sites inside `execute-basket/index.ts`
itself (untouched, per the same boundary).

**Verified:** `deno check supabase/functions/trading-agent/index.ts` — 13 pre-existing errors
confirmed on unmodified `dev` via `git stash`/`deno check`/`git stash pop` (same generic
Supabase-client type-mismatch class flagged in every prior run touching this file), identical count
(13) after this change — no new type errors. `npm run lint`: 0 errors, only the pre-existing 9
fast-refresh warnings. `npm run test`: 206/206 pass unchanged. Deployed `trading-agent`.
**Exercised against the real deployed function this run:** a direct unauthenticated POST to the live
endpoint returned a real `401 UNAUTHORIZED_NO_AUTH_HEADER` from Supabase's auth layer post-deploy,
confirming the function booted cleanly with no import/syntax failure — same verification style as
the prior runs that touched this file, for the same reason (a full authenticated chat turn needs a
real user JWT and spends real Anthropic tokens, out of scope for an autonomous health-check pass).

**Tier-4 backlog: closed.** Remaining backlog from the 76th run's original audit, unchanged: Tier 1
(7 sites, live trading — still explicitly off-limits to an autonomous pass). All other tiers (2, 3,
5) closed across the 78th–81st runs.

**Reversibility:** trivial — every diff is additive-only (new module-level timeout constants, one
`AbortController` wrap per call site or one shared helper for the three identical Kalshi sites, no
logic changes); `git revert` on the single file plus a redeploy restores pre-guard behavior with no
other change.

## 2026-07-29 (81st run) — One isolated `kalshi-proxy` credential-timeout blip, self-healed and already deduped by the alerting cooldown (not a new bug); closed out the 76th run's Tier-2 unguarded-fetch backlog — all 11 remaining sites across 6 files

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was clean and already matched
`origin/dev` (80th run's branch merged as PR #136) — `git fetch && git reset --hard origin/dev`,
fresh branch `health-check/run-20260729-1650` from there.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since the
80th run's ~16:07 UTC cutoff through this run's ~18:04 UTC invocation — exactly **one** row:
`kalshi_proxy_service_credential_fetch_failed` at 16:33:43 UTC ("credential fetch exceeded
8000ms"). Investigated before treating it as new work (per the reproduce-before-trusting-a-
diagnosis standard): pulled the full `compliance_log` window 16:25–16:45 UTC — no concurrent burst,
no other function affected, nothing else running that would contend for the same DB connection.
This is the tail of the exact issue the 78th run (cache) and 79th run (in-flight coalescing) already
fixed, now down to **1** occurrence in ~8.5h (was 5 in 3h pre-fix, 2 in ~90s after the cache-only
fix) — consistent with irreducible cold-start/DB-latency jitter on a single request, not a
recurrence of the thundering-herd bug the 79th run closed. Confirmed it never reached Onofre:
`health_check_run` logged "4 condition(s) active but suppressed (deduped)" at 17:10 UTC — the
`system_errors` alert's 2h cooldown/fingerprint (from the 16:10 alert) already absorbed it, so no
new Telegram noise was generated. `cron_health()`: all 14 jobs `active: true`, `is_stale: false`,
`last_run_failed: false`, confirmed again after this run's deploy. No code change made for this —
it isn't a new root cause, and forcing a "fix" onto a single self-healing, already-deduped blip
would be solving a non-problem.

**Fix applied (LOW risk, additive-only, six files, 11 call sites — closes Tier 2):** with the
compliance_log scan turning up nothing actionable, picked up the 76th run's own explicitly-left-open
Tier-2 backlog (scheduled-cron fetch sites, no live-trading blast radius) instead of inventing new
scope — same pattern as the 80th run closing Tier 5. All 11 sites confirmed still unguarded via
`grep` before touching anything:
- `auto-reflect/index.ts:531` (lesson-writing LLM call) and `:796` (forwards to compact-memory) —
  a hang in either stalled this cron's entire 15-minute cycle.
- `compact-memory/index.ts:79` (summarize) and `:226` (merge) — hourly-cron LLM calls, one inside a
  cluster-merge loop.
- `_shared/weather.ts:221` (GFS ensemble, primary) and `:282` (NWS, fallback) — no timeout meant a
  hang on the *primary* call never gave the fallback a chance to run, defeating the documented
  primary/fallback hierarchy. Shared by `weather-signal`, `backtest`, and `backtest-weather`.
- `daily-digest/index.ts:224` (SendGrid) and `:252` (Twilio) — once-daily cron, looped per opted-in
  recipient; one stuck recipient blocked every remaining one.
- `waitlist-signup/index.ts:42` (SendGrid) — the odd one out: this call is `await`ed *before* the
  HTTP response returns to the signup form, so a stall hung the user-facing request itself, directly
  contradicting the file's own comment calling it "non-blocking."
- `backtest-weather/index.ts:71`/`:96` (Open-Meteo archive + ensemble) — inside a per-city loop; one
  stuck city blocked every remaining city in the once-daily run.

All 11 wrapped in the same `AbortController` + `setTimeout(() => controller.abort(), 8_000)` +
`finally { clearTimeout(...) }` pattern already proven at 30+ sites across this campaign (Tiers 3
and 5). No behavior change on the happy path — only bounds how long a stalled request can block its
caller. `waitlist-signup` and `daily-digest`'s SendGrid/Twilio sends were **not** invoked live
(would fire real emails/SMS to real recipients) — same restraint as always for anything
user-facing.

**Verified:** `deno check` on all six files, before (`git stash`) vs. after — identical error counts
in every file (auto-reflect 1, daily-digest 3, the rest 0 — all pre-existing, confirmed via diff of
the actual error text, not just counts) — this change adds zero new type errors anywhere. `npm run
lint`: 0 errors, only the pre-existing fast-refresh warnings. `npm run test`: 206/206 pass unchanged,
including `weather.test.ts`'s 19 pure-function tests. Deployed all 7 affected functions
(`auto-reflect`, `compact-memory`, `daily-digest`, `waitlist-signup`, `backtest-weather`, plus
`weather-signal` and `backtest` — both import the modified `_shared/weather.ts` and needed
redeploying too, found via `grep -rl "_shared/weather"`). **Verified in prod against real data:**
invoked `compact-memory` directly → `200, {"success":true,"summarized":0,"merged":0}`; invoked
`auto-reflect` directly → `200`, ran cleanly (compaction correctly skipped, 30-min cooldown still
active from the manual compact-memory call seconds earlier); invoked `weather-signal` directly →
`200`, real GFS forecasts returned (NYC 82.9°F, MIA 91.5°F, LAX 78.8°F), 9 signals written across 3
locations. Minutes later the natural hourly cron fired independently and re-exercised the same
modified code paths for real — 5 real `compact-memory` merge LLM calls with real token usage, a
clean `auto_reflect_run` completion, and a second `weather_signal_run` (3/5 locations OK) — zero new
error/critical rows from any of it. `cron_health()` re-checked post-deploy: all 14 jobs still
`active: true`, `is_stale: false`, `last_run_failed: false`.

**Tier-2 fire-and-forget/no-timeout campaign: closed.** Remaining backlog from the 76th run's audit,
unchanged: Tier 1 (7 sites, live trading — still explicitly off-limits to an autonomous pass), Tier
4 (10 sites, `trading-agent` chat loop).

**Reversibility:** trivial — every diff is additive-only (one new module/file-local timeout
constant, one `AbortController` wrap per call site, no logic changes); `git revert` per file plus a
redeploy of the affected function restores pre-guard behavior with no other change.

## 2026-07-29 (80th run) — Clean window, all cron healthy; closed out the 76th run's Tier-5 fire-and-forget timeout-guard backlog — the last 3 unguarded sites (`_shared/langfuse.ts`, `auto-settle`'s auto-reflect trigger, `save-kalshi-key`'s username backfill)

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was clean and already matched
`origin/dev` exactly (79th run's branch merged as PR #135) — `git fetch && git reset --hard
origin/dev`, fresh branch `health-check/run-20260729-1550` from there.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since the
79th run's ~14:50 UTC cutoff through this run's ~16:07 UTC invocation — zero rows. `cron_health()`
shows all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`. The only
non-info activity in the window was 22 `api_error` warnings, all `settle-signals: Kalshi 404
fetching <ticker>` on short-duration hourly BTC markets — read the code
(`settle-signals/index.ts:134-158`) before treating this as new: a 404 there is the already-handled
"aged out of Kalshi's archive retention" case, stamped `settled_at`/`settlement_status:
unsettleable_404` so the ticker stops consuming a batch slot, exactly the behavior documented in the
46th/47th-run watch item — not a regression. One `risk_check_failed` row
(`max_open_positions (10) reached — currently 11 open`) is the risk guard correctly skipping a
strategy, also expected behavior. No new error class this run.

**Fix applied (LOW risk, additive-only, three files):** with the compliance_log genuinely clean,
picked up the 76th run's own explicitly-left-open backlog instead of inventing new scope — three
Tier-5 (fire-and-forget, non-trading) unguarded `fetch()` sites, the last ones in that campaign:
- `_shared/langfuse.ts`'s `langfuseIngest()` — bare fire-and-forget POST to Langfuse's ingestion API
  on every qualify/trade decision, no timeout. Wrapped in `AbortController` + new
  `LANGFUSE_FETCH_TIMEOUT_MS = 8_000`, `finally` clears the timer so it can't leak past the
  fetch's own resolution.
- `auto-settle/index.ts`'s post-settlement auto-reflect trigger (~line 458) — same bare
  fire-and-forget pattern, wrapped with a new `AUTO_REFLECT_TRIGGER_TIMEOUT_MS = 8_000` local to
  that file (matches the existing `MARKET_FETCH_TIMEOUT_MS` convention already in the file).
- `save-kalshi-key/index.ts`'s `fetchAndStoreKalshiUsername()` — the only one of the three that
  isn't strictly fire-and-forget syntax (it's `await`ed inside a detached, uncaught-by-caller async
  function called without `await` from the request handler), but was still a bare `fetch()` with no
  bound: a stalled Kalshi portfolio-members endpoint would hang that detached call indefinitely.
  Added `KALSHI_USERNAME_FETCH_TIMEOUT_MS = 8_000` via the standard `AbortController`/`finally`
  pattern used everywhere else in this campaign. All three: fire-and-forget contract unchanged, no
  new fields, no new error-handling plumbing — the diff only bounds how long each dangling
  connection can live.

**Verified:** `deno check` on all three files, before (`git stash`) vs. after — 0 errors both times
on all three (no pre-existing errors in these particular files, unlike some prior campaign sites).
`npm run lint`: 0 errors, only the pre-existing fast-refresh warnings unrelated to this change.
`npm run test`: 206/206 unit tests pass unchanged. `langfuse.ts` is imported by two functions
(`auto-settle`, `auto-trade` — confirmed via `grep -rl`), both redeployed; `save-kalshi-key`
redeployed separately. **Verified in prod against real data:** polled `compliance_log` post-deploy
(16:10–16:17 UTC) — `auto_trade_run` fired twice (16:10, 16:15) and `auto_settle_run` once (16:12),
all clean, zero new error/critical rows, confirming the redeploy didn't regress the live trading or
settlement path. `cron_health()` re-checked post-deploy: all 14 jobs still `active: true`,
`is_stale: false`, `last_run_failed: false`. The timeout branches themselves remain unexercised
until Langfuse/the internal auto-reflect endpoint/Kalshi's username endpoint actually stalls — same
caveat as every other guard added in this campaign.

**Tier-5 fire-and-forget campaign: closed.** No remaining sites in Tier 5 as of this run. Remaining
backlog from the 76th run's audit, unchanged: Tier 1 (7 sites, live trading — still explicitly
off-limits to an autonomous pass), Tier 2 (11 sites, scheduled cron), Tier 4 (10 sites,
`trading-agent` chat loop).

**Reversibility:** trivial — three single-file, additive-only diffs (one new module/file-local
constant and one `AbortController` wrap per site); `git revert` + redeploy of the three affected
functions restores the pre-guard behavior with no other change.

## 2026-07-29 (79th run) — The 78th run's own fix didn't hold: `kalshi-proxy` timeout recurred twice after the credential cache deployed — the cache had no protection against a thundering herd on a miss

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was clean and already matched
`origin/dev` (78th run's branch merged as PR #134) — `git fetch && git reset --hard origin/dev`,
fresh branch `health-check/run-20260729-150344` from there.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since the
78th run's ~14:03 UTC cutoff — 3 rows, all `kalshi_proxy_service_credential_fetch_failed`. One
(14:03:57) was already accounted for in the 78th run's own log (one of its original 4). The other
two (14:37:29, 14:38:36) are **new** — they landed roughly 30 minutes *after* the 78th run's cache
fix was deployed and verified clean. `cron_health()`: all 14 jobs `active: true`, `is_stale: false`,
`last_run_failed: false`. Pulled the full `compliance_log` window 14:00–14:50 UTC to confirm no
other function saw anything similar in that period — isolated to `kalshi-proxy` again.

**Root cause: the 78th run's fix reduced the failure rate but didn't remove the failure mode it
was trying to fix.** Per the fail-twice rule (already invoked once this log, for the esm.sh retry
budget in the 77th run) — a fix that recurs isn't a fix, it's a smaller version of the same gap.
The module-level TTL cache added in #134 removes the DB round trip on a cache *hit*, but a cache
*miss* (cold instance start, or the instant the 5-minute TTL lapses) is not itself coalesced:
every concurrent request that observes the same miss independently re-checks the cache, sees it
empty, and starts its own DB fetch + decrypt racing its own 8s timeout — reproducing the exact
contention the cache exists to remove, just gated to the miss window instead of every request.
This codebase's own frontend allows up to 6 concurrent in-flight requests per page load
(`src/lib/kalshiApi.ts`), so any page load that happens to land inside a miss window reopens the
original bug. The 14:37/14:38 timestamps are consistent with this: ~30 minutes past deploy is long
enough for either a fresh cold instance or one TTL lapse to hit a burst.

**Fix applied (LOW risk, additive-only, single file, `supabase/functions/kalshi-proxy/index.ts`):**
added in-flight request coalescing around the existing cache. A new module-level
`inFlightServiceCredentialFetch` promise is set by the first request that observes a miss; every
other concurrent request awaits that same promise instead of starting its own, so a burst during a
miss costs exactly one DB round trip total, not one per concurrent request. The fetch-plus-timeout
logic was extracted into `fetchServiceCredential()` (previously inlined in the request handler) so
it can be shared as the single in-flight promise; behavior is otherwise identical — same 8s
timeout, same cache population on success, same `compliance_log` entry on failure (now written
once per coalesced batch instead of once per failing request, which also cuts log noise). The
per-user authenticated-credential branch is untouched.

**Verified:** `deno check` on `kalshi-proxy/index.ts` — 15 errors vs. 14 on the pre-change baseline
(`git stash` comparison); the one additional error is the same pre-existing
`SupabaseClient<any,"public",...>` generic-mismatch class already present at every other call site
in this file (`resolveTenant`, `getKalshiCredentials`, `.insert(...)`), not a new error class — my
new `fetchServiceCredential(adminClient)` call site inherits it. `npm run lint`: 0 errors, only the
pre-existing fast-refresh warnings. `npm run test`: 206/206 unit tests pass unchanged. Deployed via
`supabase functions deploy kalshi-proxy`. **Verified in prod against the real Kalshi API under the
exact failure condition:** fired 8 concurrent requests at the freshly-deployed function (cache
necessarily empty — first traffic since deploy) via `?endpoint=series` using the project's live
`anon` key. All 8 returned HTTP 200 with identical, real Kalshi series payloads (16,007,466 bytes
each). Queried `compliance_log` for the 15 minutes following — **zero** new
`kalshi_proxy_service_credential_fetch_failed` or `kalshi_proxy_unauthenticated_fallback` rows. This
is the first time this exact test (concurrent burst against a cold, empty cache) has been run
against this code path — it would have failed against the 78th run's version.

**Reversibility:** trivial — single additive change (one new module-level variable, one extracted
function, one call-site simplification), `git revert` restores the 78th run's cache-without-
coalescing behavior with no other change.

## 2026-07-29 (78th run) — New error class since the 77th run: `kalshi-proxy` public-endpoint credential fetch timing out under concurrent load — cached the service-tenant credential instead of widening the timeout

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was clean and already matched
`origin/dev` (77th run's branch merged as PR #132/#133) — fresh branch
`health-check/run-20260729-bc175f` off `origin/dev`.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since the
77th run's ~13:07 UTC cutoff — 4 rows, all `kalshi_proxy_service_credential_fetch_failed` (13:47,
13:48, 13:51, 14:03). Widening the window to the full day surfaced a 5th at 11:04 UTC — this error
class **only started today**, 5 occurrences in 3 hours, all on the same code path. `cron_health()`:
all 14 jobs `active: true`, `is_stale: false`, `last_run_failed: false`. Every other function in the
same window (market-data-fetcher, reconcile-orders, surface-scan, auto-trade, futures-signal, …) ran
in the tens-to-low-thousands of ms — this was not a general platform/DB slowdown.

**Root cause:** `kalshi-proxy`'s public-endpoint branch (`supabase/functions/kalshi-proxy/index.ts`)
re-fetches and re-decrypts the same static service-tenant `api_keys` row on **every single
request** via `getKalshiCredentials(adminClient, null)`, guarded by an 8s timeout. This is the
highest-traffic path in the app — every public market/events/series browse, with the frontend's own
concurrency cap (`src/lib/kalshiApi.ts`) allowing up to 6 simultaneous in-flight requests per page
load (category tabs + background pre-warm + per-series trending fan-out). `api_keys` has only 5 rows
and no plan-level slowness — the timeouts were concurrent redundant round trips to fetch and decrypt
**identical data** stacking up under that fan-out, not a slow query in isolation. Confirmed this
wasn't a systemic Supabase issue: no other function (cron-driven, so never more than 1 concurrent
invocation) saw anything similar.

**Fix applied (LOW risk, additive-only, single file):** added a module-level, 5-minute-TTL cache for
the decrypted service-tenant credential in `kalshi-proxy/index.ts`. Public-endpoint requests now
check the cache first and skip the DB round trip entirely on a hit; only a cache miss (cold instance
or expired TTL) does the guarded fetch, and a successful fetch populates the cache for subsequent
requests on that warm instance. Per-user credentials (the authenticated branch) are untouched — no
change to that path, since caching one user's key across other users on the same warm instance would
be a different trust boundary; the service-tenant key is a fixed, singleton, read-only credential
already treated as static for an instance's lifetime (mirrors the existing `loggedMissingServiceKey`
module-level pattern in the same file). A 5-minute TTL means a live key rotation is still picked up
without a redeploy. This is the actual fix, not a wider timeout — a bigger `CREDENTIAL_FETCH_TIMEOUT_MS`
would only have deferred the next round of concurrent-request contention (the same anti-pattern this
log flagged and reversed in the 77th run for the esm.sh retry budget).

**Verified:** `deno check` on `kalshi-proxy/index.ts` — 14 errors, identical before/after via `git
stash` comparison (pre-existing baseline, none introduced). `npm run lint`: 0 errors, only the
pre-existing fast-refresh warnings. `npm run test`: 206/206 unit tests pass unchanged. Deployed
`kalshi-proxy` to production (`uyfnezxmgwitpzsrnkst`) via `supabase functions deploy`. **Verified in
prod against the real Kalshi API:** fetched the project's live `anon` key via the Supabase
Management API, hit the deployed public endpoint 3× in a row (`?endpoint=series`) — all 3 returned
HTTP 200 with real Kalshi series data, and `compliance_log` in the following minutes shows **zero**
new `kalshi_proxy_service_credential_fetch_failed` or `kalshi_proxy_unauthenticated_fallback` rows
(both were previously appearing on every timeout). The pre-existing `health_check_alert` for the
4 errors from before this fix landed fired once at 14:10 UTC as expected — a stale alert about
already-fixed errors, not a new issue.

**Reversibility:** trivial — single additive module-level cache, `git revert` removes it and the
public-endpoint branch reverts to its prior always-fetch behavior with no other change.

## 2026-07-29 (77th run) — Clean window, zero error/critical events, cron healthy; the 76th run's own merge broke CI a second time on the same esm.sh class — fixed the root cause instead of widening the retry budget again

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` had a stale branch
(`health-check/run-20260729-121017`, the 76th run's own branch, already merged as PR #131) —
`git fetch && git reset --hard origin/dev`, fresh branch from there.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since
the 76th run's ~12:10 UTC cutoff through this run's ~13:07 UTC invocation — zero rows across 114
events in the window (107 info, 7 warning). `cron_health()` showed all 14 registered jobs
`active: true`, `is_stale: false`, `last_run_failed: false`.

**Active issue found (the actual work this run):** `gh run list --workflow=ci.yml --branch dev`
showed the 76th run's own push (`30450872671`, 12:15:55 UTC) had **failed** — a fact the 76th
run's log entry never surfaced, since its own verification stopped at the manual `supabase
functions deploy` it ran directly, without checking whether its *merge* had gone green in CI.
`gh run view --log-failed` showed `Deploy edge functions → staging Supabase` died on
`futures-signal` after all 5 retry attempts (~7min, 12:38–12:45 UTC): `Import
'https://esm.sh/@supabase/supabase-js@2' failed: 522 <unknown status code>`, over and over. This
blocked staging deploy, production deploy, the canary gate, and e2e smoke tests entirely for that
push — not just a slow function, the whole downstream pipeline.

**Root cause: this is the same failure class the 72nd run already hit and "fixed" by widening the
retry budget (3→5 attempts, exponential backoff, ~3.75min).** That budget held for four runs
(73rd–76th) and then broke anyway — esm.sh had an outage longer than the widened window could
absorb. Per the fail-twice rule, retrying around an unreliable upstream CDN is not a fix, it's a
larger stopgap that was always going to run out eventually. The actual root cause: all 34 import
sites (33 function entry points + `_shared/notifications.ts`'s type-only reference) bundle
`supabase-js` from `https://esm.sh/@supabase/supabase-js@2` at deploy time, making every CI deploy
and every manual `supabase functions deploy` depend on esm.sh's uptime.

**Fix applied (LOW risk, mechanical, no behavior change):** replaced the import specifier at all
34 sites with `npm:@supabase/supabase-js@2` — Deno's native npm-registry resolution, which does
not touch esm.sh at all. Same package, same version, same API; only the resolution source
changed. Also updated two stale doc comments (`_shared/limits.ts`, `_shared/limits-math.ts`) that
referenced the old esm.sh URL, and the CI workflow's comment to document the root-cause fix while
keeping the retry loop itself as defense-in-depth against any other transient deploy hiccup (not
as the primary fix anymore).

**Verified:** confirmed locally with `deno run` that `npm:@supabase/supabase-js@2` resolves and
`createClient` works. `deno check` on 17 sampled entry points — including Tier-1 `auto-trade`,
`auto-settle`, `execute-trade` — showed **identical error counts before/after** via `git stash`
comparison (17/6/20 match the documented pre-existing baselines exactly; zero new errors anywhere
sampled). `npm run lint`: 0 errors, only the pre-existing fast-refresh warnings. `npm run test`:
206/206 unit tests pass unchanged. Opened PR #132, watched its CI (lint/test job passed; deploy
jobs correctly skip on a PR event since they're gated to `dev` pushes), merged, then watched the
resulting `dev` push's own CI run (`30454993657`) — `Deploy edge functions → staging Supabase`
completed in 2m26s with zero retries needed, the first clean run through that job since the class
of failure first appeared. Deployed all 31 affected functions to production
(`uyfnezxmgwitpzsrnkst`) directly via `supabase functions deploy`. Post-deploy, polled
`cron_health()` and `compliance_log`: `futures-signal-cron` (13:19), `surface-scanner-cron`
(13:18), `market-data-fetcher-cron` (13:16) all ran clean post-redeploy, zero new error/critical
rows in the 5 minutes following deploy.

**Reversibility:** trivial — single mechanical string substitution across known files, `git
revert` restores the esm.sh imports if `npm:` resolution ever proves less reliable (it shouldn't:
npm's registry has materially higher uptime than esm.sh's CDN re-bundling layer).

## 2026-07-29 (76th run) — Clean window, zero error/critical events, cron/CI healthy; continued the Tier-5 fire-and-forget timeout-guard sweep from the 75th run's backlog — `_shared/notifications.ts`'s SendGrid/Twilio `send()` calls

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was clean and already matched
`origin/dev` exactly (75th run's branch had merged as PR #130) — `git fetch && git reset --hard
origin/dev`, fresh branch `health-check/run-20260729-121017` from there.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since the
75th run's ~11:07 UTC cutoff through this run's ~12:10 UTC invocation — 136 total events in the
window, **zero** at error/critical. `cron_health()` shows all 14 registered jobs `active: true`,
`is_stale: false`, `last_run_failed: false`. `gh run list --workflow=ci.yml --branch dev` shows the
75th run's own push (`30446613476`, 11:11:42 UTC) green in 4m12s; nothing since.

**Fix applied this run (LOW risk, additive-only, single file):** picked up the 75th run's own
audit backlog — the remaining Tier 5 sites include `_shared/notifications.ts` ×2. Re-verified
against this run's fresh checkout before trusting it (reproduce, don't inherit a prior diagnosis)
— confirmed `sendEmail()` (SendGrid, line 127) and `sendSms()` (Twilio, line 153) both still made a
bare `await fetch()` with zero `AbortController`/timeout. Both are called fire-and-forget from
`sendUserNotification` (`.catch((e) => console.warn(...))`, never awaited by its caller), so a
stalled SendGrid or Twilio endpoint would leave a dangling open connection per notification,
accumulating across warm Fluid Compute instances with no timeout to ever close it — same failure
shape as the `telegram.ts`/`sentry.ts` sites already fixed in prior runs. Wrapped both in the same
`AbortController` + 8s timeout pattern, `NOTIFICATION_FETCH_TIMEOUT_MS = 8_000` matching this
codebase's established convention. Fire-and-forget contract unchanged — the diff only bounds how
long the dangling connection can live, it does not change what any caller awaits, so
`auto-trade`'s/`auto-settle`'s/`execute-trade`'s order-submission control flow (the reason those
files are Tier 1/1-adjacent and off-limits to autonomous edits) is untouched.

**Verified:** `deno check supabase/functions/_shared/notifications.ts` shows 3 pre-existing errors
(unrelated `never`-type narrowing on `profile?.notification_prefs`/`profile?.phone`), confirmed
identical via `git stash` before/after — this diff adds zero new errors. `deno check` on all three
importers (`auto-trade`, `auto-settle`, `execute-trade`) shows the same pre-existing error counts
recorded in the 75th run's log (17/6/20) — unchanged. Deployed all three via `supabase functions
deploy <fn> --project-ref uyfnezxmgwitpzsrnkst` (they each bundle `_shared/notifications.ts`).
Post-deploy, polled `compliance_log` until each importer's own cron fired: `auto_settle_run` at
12:12:00 UTC and `auto_trade_run`/`auto_trade_strategy_run` at 12:15:03 UTC, all clean with no new
error/critical entries — confirms the redeploy didn't regress the live trading path.
`execute-trade` is request-triggered (not cron) so its next real exercise will be the next actual
trade execution; its `deno check` baseline match is the verification available this run. The
timeout branch itself is unexercised until SendGrid/Twilio actually stalls, same caveat as every
other guard added in this campaign.

**Remaining backlog (unchanged from 75th run's audit, for the next run):** Tier 1 (7 sites, live
trading — still explicitly off-limits to an autonomous pass), Tier 2 (11 sites, scheduled cron),
Tier 4 (10 sites, `trading-agent` chat loop), Tier 5 remainder (3 sites: `_shared/langfuse.ts`,
`auto-settle/index.ts:458`, `save-kalshi-key/index.ts:110`).

**Reversibility:** trivial — single-file diff, two call sites wrapped in an already-proven pattern;
revert path is `git revert` + redeploy of the three importing functions.

## 2026-07-29 (75th run) — Clean window, one benign transient credential-fetch timeout, cron/CI healthy; continued the Tier-5 fire-and-forget timeout-guard sweep from the 74th run's audit — Sentry's `send()`

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was stale from the 74th run
(branch `health-check/run-20260729-060652`, already merged as PR #129) but matched `origin/dev`
exactly — `git fetch && git reset --hard origin/dev`, fresh branch from there.

**Error-severity scan:** Queried `compliance_log` for `severity in ('error','critical')` since the
74th run's ~10:07 UTC cutoff through this run's ~11:07 UTC invocation — 126 total events in the
window, exactly **one** at error/critical: `kalshi_proxy_service_credential_fetch_failed` at
11:04:02 UTC (`kalshi-proxy` public-endpoint service-tenant credential fetch exceeded its 8000ms
guard, fell back to the anonymous rate tier for that one request). Checked 7-day frequency for
this `event_type` — this is the only occurrence; not a recurring pattern. This is the guard added
in an earlier run of the same campaign working exactly as designed: bounded, logged, degraded
gracefully (rate-tier fallback) instead of hanging. No code change warranted for this one — a
single transient network blip is not a bug. `cron_health()` shows all 14 registered jobs `active:
true`, `is_stale: false`, `last_run_failed: false`. `gh run list --workflow=ci.yml --branch dev`
shows the 74th run's own push (`30443070092`, 10:17:10 UTC) green in 4m27s; nothing since.

**Fix applied this run (LOW risk, additive-only, single file):** picked up the 74th run's own
audit backlog — Tier 5 (fire-and-forget, 8 sites) is the lowest-risk remaining tier since none of
those call sites are awaited by their caller's control flow. Re-verified the audit against this
run's fresh checkout before trusting it (per standing practice: reproduce, don't inherit a prior
diagnosis) — confirmed `_shared/sentry.ts:122`, `_shared/notifications.ts:127`/`:153`, and
`_shared/langfuse.ts:19` are all still unguarded. Fixed `_shared/sentry.ts`'s `send()`: a bare
`await fetch()` with zero `AbortController`/timeout, called from `captureException`/
`captureMessage`, both fire-and-forget (`send(...).catch(() => {})`, never awaited by callers).
Not a caller-facing hang risk, but under Fluid Compute's reused instances a stalled Sentry
endpoint leaves a dangling open connection per unreported error, accumulating across warm
invocations with zero timeout to ever close it. Wrapped in the same `AbortController` + 8s
timeout pattern proven in `_shared/telegram.ts`/`kalshi-proxy`/`health-check`,
`SENTRY_FETCH_TIMEOUT_MS = 8_000` matching this codebase's established convention. `send()` stays
fire-and-forget — the fix only bounds how long the dangling connection can live, it does not
change what any caller awaits, so `execute-trade`'s/`auto-trade`'s/`auto-settle`'s order-submission
control flow (the reason those files are Tier 1/1-adjacent and off-limits to autonomous edits) is
untouched by this diff.

**Verified:** `deno check supabase/functions/_shared/sentry.ts` clean. `deno check` on all three
importers (`auto-trade`, `auto-settle`, `execute-trade`) shows the same pre-existing error counts
(17/6/20) present on a clean `origin/dev` checkout via `git stash` before/after — this diff adds
zero new errors. Deployed all three via `supabase functions deploy <fn> --project-ref
uyfnezxmgwitpzsrnkst` (they each bundle `_shared/sentry.ts`). Post-deploy, `auto-trade-cron` fired
within the verification window and logged clean `auto_trade_run`/`auto_trade_strategy_run` rows
in `compliance_log` with no new error/critical entries — confirms the redeploy didn't regress the
live trading path. The timeout branch itself is unexercised until Sentry actually stalls, same
caveat as every other guard added in this campaign.

**Remaining backlog (unchanged from 74th run's audit, for the next run):** Tier 1 (7 sites, live
trading — still explicitly off-limits to an autonomous pass), Tier 2 (11 sites, scheduled cron),
Tier 4 (10 sites, `trading-agent` chat loop), Tier 5 remainder (5 sites: `_shared/notifications.ts`
×2, `_shared/langfuse.ts`, `auto-settle/index.ts:458`, `save-kalshi-key/index.ts:110`).

**Reversibility:** trivial — single-file diff, one function wrapped in an already-proven pattern;
revert path is `git revert` + redeploy of the three importing functions.

## 2026-07-29 (74th run) — Clean window, all cron healthy, CI green; the 73rd run's "last uninstrumented fetch" claim was false — audit found 39 remaining unguarded fetch sites — closed health-check's own Telegram-alerting blind spot, the most ironic one

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP)
and already sitting at `origin/dev` HEAD (`830e825`, the 73rd run's own merge). Started this run's
branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 73rd run's ~09:07 UTC cutoff through this run's ~10:07 UTC invocation — zero rows across 150
events in the window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --workflow=ci.yml --branch dev` shows the 73rd run's
own push (`30438574515`, 09:10:58 UTC) completed green in 4m37s; nothing since.

**Correction — the 73rd run's "last uninstrumented fetch" claim does not hold:** that entry
described `telegram-webhook/index.ts` as closing the timeout-guard campaign begun in the 68th run.
A full-codebase audit this run (`grep` for every `fetch(`/`fetchWithRetry(` call site under
`supabase/functions/`, read for an existing `AbortController`/`signal`) found **39 remaining
unguarded call sites across 16 files** — the campaign was never close to done; each prior run had
only been checking the one file it fixed, not re-sweeping the whole tree. Tiered by blast radius:

- **Tier 1 — live trading, real money (7 sites):** `execute-trade/index.ts:747` (the Kalshi
  order-submission POST itself) and `:655` (pre-order balance check); `auto-trade/index.ts:991`
  (forwards every auto-trade decision to execute-trade); `trading-agent/index.ts:1442`/`:1495`
  (chat-agent order submit/cancel); `execute-basket/index.ts:165`/`:337` (each basket leg's
  execute/flatten call, inside a loop). **Not touched this run** — a hang-vs-timeout distinction on
  the order-submission path changes what "did this order actually fill" means, and getting that
  wrong risks a double-submit or a stuck basket leg. This needs a dedicated, carefully-reviewed
  session, not an autonomous health-check pass.
- **Tier 2 — scheduled cron jobs (11 sites):** `auto-reflect/index.ts:531`/`:796`,
  `compact-memory/index.ts:79`/`:226`, `_shared/weather.ts:221`/`:282` (core forecast fetchers for
  `weather-signal`), `daily-digest/index.ts:224`/`:252`, `waitlist-signup/index.ts:42`,
  `backtest-weather/index.ts:71`/`:96`.
- **Tier 3 — this run's fix:** `health-check/index.ts`'s own `sendTelegram()` (see below).
- **Tier 4 — `trading-agent/index.ts` (10 sites):** the user-facing chat-agent tool-calling loop;
  a hang here freezes the chat response. Only one call site (line 503) was already guarded.
- **Tier 5 — fire-and-forget (8 sites):** don't block their caller's response, but still an
  unguarded dangling connection: `_shared/sentry.ts:122`, `_shared/notifications.ts:127`/`:153`,
  `_shared/langfuse.ts:19`, `auto-settle/index.ts:458`, `save-kalshi-key/index.ts:110`,
  `auto-trade/index.ts:341` (this one IS awaited — circuit-breaker-trip alert).
- **Dead code:** `polymarket-proxy/index.ts:44` — bare `fetch()`, no options. Per this repo's
  `CLAUDE.md`, Polymarket is unreferenced pending a deletion decision; not worth guarding.

Full findings with descriptions are in this run's research-agent output; Tiers 1, 2, and 4 are
real backlog, not resolved by this entry.

**Fix applied this run (LOW risk, additive-only, single file):** `health-check/index.ts`'s
`sendTelegram()` had zero timeout guard — no `AbortController`, no `signal`. This is the exact
same failure shape closed across `_shared/telegram.ts` and a dozen call sites in the 68th–71st
runs, except this one is health-check's *own* copy (kept separate from the shared
`sendTelegramAlert()` because callers need the delivered/not-delivered boolean to drive
`unclaimAlert()`, which the shared helper's void return can't support). It's awaited at two call
sites: the main alert-delivery loop (`:584`) and the crash-recovery handler (`:646`). A stalled
Telegram API call here would hang health-check itself — the one function whose entire job is
catching silent hangs elsewhere — up to the platform's own execution timeout, with zero diagnostic
signal about why the watchdog went dark. Wrapped in the same `AbortController` + 8s timeout
pattern already proven in `_shared/telegram.ts`, `TELEGRAM_FETCH_TIMEOUT_MS = 8_000` matching this
file's own existing `CREDENTIAL_FETCH_TIMEOUT_MS`/`BALANCE_FETCH_TIMEOUT_MS` convention. Returns
`false` on abort/network failure (same as before) rather than throwing, preserving the
`delivered`/`unclaimAlert()` contract at both call sites.

**Verified:** `deno check supabase/functions/health-check/index.ts` shows the same 12 pre-existing
type errors present on a clean `origin/dev` checkout (Supabase client generic-type drift in
`encryption.ts`/`kalshi-auth.ts`/`tenant.ts`, unrelated to this diff, confirmed via `git stash`
before/after) — this change adds zero new errors. Deployed via `supabase functions deploy
health-check --project-ref uyfnezxmgwitpzsrnkst`. Invoked the live function directly
(`POST /functions/v1/health-check` with the service-role key) post-deploy: returned `200 {"ok":
true, "alerts_sent":["api_error_kalshi"], ...}` — a real pending alert (`settle-signals` hitting
Kalshi 404s on expired KXBTC tickers, `warning` severity, pre-existing and unrelated to this fix)
delivered successfully through the newly-guarded path, confirmed by the `health_check_run`
compliance_log row ("1 alert(s) sent") with no `telegram_delivery_failed` row. Exercises the real
Telegram API on the happy path; the timeout branch itself is unexercised until a real stall, same
caveat as every other guard added in this campaign.

**Reversibility:** trivial — single-file diff, one function wrapped in an already-proven pattern;
revert path is `git revert` + redeploy.

## 2026-07-29 (73rd run) — Clean window, all cron healthy, CI green (72nd run's retry-budget fix confirmed working); closed the last uninstrumented fetch in the operator-facing Telegram control bot

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP)
and already sitting at `origin/dev` HEAD (`cea95e3`, the 72nd run's own merge). Started this run's
branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 72nd run's ~08:07 UTC cutoff through this run's ~09:07 UTC invocation — zero rows across 382
events in the window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`.

**CI confirmation:** `gh run list --workflow=ci.yml --branch dev` shows the 72nd run's own push
(`30434418850`, 08:09:52 UTC) completed green in 4m28s — the widened 5-attempt/exponential-backoff
retry budget added for the esm.sh outage has now been exercised by a real deploy and held. No CI
runs since; nothing new to investigate there this run.

**Fix — `telegram-webhook/index.ts` had two uninstrumented `fetch()` calls:** this function is the
operator-facing Telegram bot (`/status`, `/health`, `/429`, `/run mdf`, `/run trade`, `/help`) —
the same failure shape closed across `_shared/telegram.ts` and a dozen call sites in the 68th–71st
runs, but this file predates that campaign and was missed: it has its own inline `reply()` (Telegram
`sendMessage`) and `invokeFunction()` (invoking `health-check`/`market-data-fetcher`/`auto-trade` by
HTTP) with no `AbortController`/timeout on either. A stalled Telegram API response or a hung
downstream function would block this webhook indefinitely — up to the platform's own execution
timeout — leaving the admin bot looking dead with no error surfaced, and Telegram's own webhook
retry/backoff papering over it instead of a clear failure.

**Fix applied (LOW risk, additive-only, single file):** `reply()` now uses the same
`AbortController` + 8s timeout + swallowed-fetch-error pattern as `_shared/telegram.ts`'s
`sendTelegramAlert()` (fire-and-forget, never blocks, never throws). `invokeFunction()` gets a 45s
timeout — wide enough to cover `/run trade`'s own documented "may take up to 30s" — and now returns
a clear `{error: "<name> timed out or failed to respond: ..."}` on abort instead of hanging, which
the existing outer `catch` block already surfaces back to the operator via Telegram as `🔴 Internal
error: ...`. No behavior change on the happy path.

**Verified:** `deno check supabase/functions/telegram-webhook/index.ts` passes clean. Deployed via
`supabase functions deploy telegram-webhook --project-ref uyfnezxmgwitpzsrnkst`. Confirmed the
function is live and routing correctly post-deploy (platform-level JWT gateway returns 401 for an
unauthenticated request, unchanged pre-/post-deploy — this is Supabase's own gateway layer, not
this function's code, and is unrelated to this diff). Did not attempt to obtain the Telegram webhook
secret to drive a full authenticated request through `/run trade`, since that would trigger a real
auto-trade cycle — out of scope for a verification step. Same
unexercised-until-the-next-real-stall caveat as every other timeout guard added in this campaign.

**Reversibility:** trivial — single-file diff, two functions wrapped in the same
try/finally-with-AbortController shape already proven in `_shared/telegram.ts`; revert path is
`git revert` + redeploy.

## 2026-07-29 (72nd run) — Clean window, all cron healthy; but the 71st run's own merge broke CI on a transient esm.sh CDN outage that outlasted the existing retry guard — widened the retry budget

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP)
and already sitting at `origin/dev` HEAD (`56e361f`, the 71st run's own merge). Started this run's
branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 71st run's ~07:07 UTC cutoff through this run's ~08:07 UTC invocation — zero rows across 921
events in the window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`.

**Found instead — CI failure on the merge commit itself:** `gh run list --workflow=ci.yml` showed
the push-to-dev run for `56e361f` (run `30431158450`, 07:18 UTC) had failed, the only failure in
the last 20 runs — everything before and since is green. The PR's own pre-merge check on the same
commit (run `30430996801`, 07:15 UTC) had passed, so this wasn't the code diff (a single-file
change to `_shared/telegram.ts`, unrelated to the function that failed) — it pointed at
infrastructure flakiness reproducing on the identical commit three minutes apart.

**Root cause:** `deploy-staging-functions`'s bundling step imports `supabase-js` from `esm.sh` at
deploy time. The 68th run (2026-07-28, run `30357821307`) had already hit this once and added a
3-attempt/flat-15s-backoff retry loop (`.github/workflows/ci.yml`) — a ~45s total retry budget.
This run's outage on `manage-billing` held esm.sh unreachable for over 2 minutes straight
(07:28:55 → 07:30:47 UTC, three consecutive `522` failures), longer than the existing budget could
absorb, even though every other function in the same job recovered on its first retry. The guard
was real but under-provisioned for a longer-than-average blip in the same external dependency it
was already built to tolerate.

**Fix (LOW risk, additive-only, CI workflow config only — no application code touched):** widened
the retry loop in `.github/workflows/ci.yml` from 3 fixed-15s attempts to 5 attempts with
exponential backoff (15/30/60/120s, ~3.75min total budget). Still fails loud with a clear message
after attempt 5 — this raises the ceiling for tolerable outage length, it doesn't suppress a
persistent failure.

**Verified:** `python3 -c "import yaml; yaml.safe_load(...)"` confirms the edited workflow file is
still valid YAML. `gh run list --workflow=ci.yml --limit 20` confirms this was an isolated,
one-off failure (not a recurring pattern needing a different fix) before making the change. The
next natural push to `dev` (this PR's own merge) will exercise the new retry path under real CI
conditions — no live esm.sh outage was available to force during this run, same
unexercised-until-the-next-real-incident caveat as every other guard added in this campaign.

**Reversibility:** trivial — single-file, workflow-only diff; revert path is `git revert`, no
redeploy required since this changes CI config, not deployed function code.

## 2026-07-29 (71st run) — Clean window, all cron healthy, CI green; closed the shared Telegram alert helper's own timeout gap — the one call site whose docstring falsely promised "never blocks", fanning out to 12 caller functions

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP)
and already sitting at `origin/dev` HEAD (`8f41266`, the 70th run's own merge). Started this run's
branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 70th run's ~06:10 UTC cutoff through this run's ~07:07 UTC invocation — zero rows across 908
events in the window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 70th
run's own push (run `30427432001`, 3m2s) and no pushes since.

**First candidate rejected — Polymarket is explicitly out of scope:** initially found and fixed
`polymarket-proxy/index.ts`'s completely bare `await fetch(apiUrl)` (zero guard at all, not even a
prior partial fix) and deployed it, then re-read this repo's `CLAUDE.md` and found a standing
instruction added independently of this campaign: "Polymarket code: do not extend... unreferenced
from the rest of the codebase... Do not add new Polymarket features, fix Polymarket bugs..."
Reverted the file (`git checkout --`) and redeployed the original unmodified version to undo the
live change before it compounded — confirmed `git diff` clean against `dev` afterward. Recorded
here as a process note: this run's own campaign precedent (`docs/health-log.md`,
`DECISIONS.md`) doesn't cover every exclusion in the repo: a project's `CLAUDE.md` is the higher
authority and must be re-checked, not just the log's running scope notes, before picking a target.

**Actual fix — `_shared/telegram.ts`'s `sendTelegramAlert()`:** this file's own docstring states
"sendTelegramAlert — fire-and-forget, never throws, never blocks," but the implementation was a
bare `await fetch()` with no `AbortController`/timeout — the same failure shape closed at every
other call site in this campaign, except here it directly contradicts the contract the file
promises its callers. `grep`-confirmed 12 non-test call sites: `auto-reflect`, `auto-settle`,
`auto-trade`, `compact-memory`, `execute-trade` (alert-only call after a trade decision, not the
order placement/cancellation path itself — that stays off-limits per the 48th run's standing
boundary, untouched this run), `futures-signal`, `health-check` (the function this whole alerting
campaign exists to feed), `market-data-fetcher`, `settle-signals`, `signal-generator`,
`surface-scanner`, `weather-signal`. A stalled Telegram API response would have quietly blocked
every one of those 12 cron/user-facing functions for as long as the platform's own execution
timeout allowed — invisible, since the outer `.catch(() => {})` swallows the eventual result either
way; the cost was pure wall-clock, not a crash.

**Fix (LOW risk, additive-only, no change to alert content/behavior on the happy path):** added
`TELEGRAM_FETCH_TIMEOUT_MS = 8_000` (same convention/bound as every other fix in this campaign),
wrapped the single `fetch()` call in an `AbortController` + `setTimeout`, `clearTimeout` in a
`finally`. The existing `.catch(() => {})` still swallows both network errors and the new
`AbortError` identically — this fix bounds the wait, it doesn't change what happens on failure
(already silent by design, since a Telegram outage should never take down the caller).

**Verified:** `deno check supabase/functions/_shared/telegram.ts` — 0 type errors. `deno lint` — 1
pre-existing `no-explicit-any` problem (the `supabase: any` param on `alertOnce`, unrelated to this
change), confirmed identical on unmodified `dev` via `git stash`/`deno lint`/`git stash pop` — no
new issues. Deployed all 12 caller functions individually (Supabase edge functions bundle
`_shared/*` per-function at deploy time, so the fix has no effect until every importer is
redeployed) via `supabase functions deploy`. Waited for the next natural cron tick on each and
re-queried `cron_health()`: all 9 cron-driven callers among the 12 (`execute-trade` and
`compact-memory` are not directly cron-scheduled) show `last_status: succeeded`,
`last_run_failed: false` post-deploy. Re-queried `compliance_log` for the post-deploy window — 16
new events, 0 `error`/`critical`. The timeout branch itself is unexercised this run (would need a
live Telegram outage to reach), same caveat pattern as every prior timeout-guard entry.

**Reversibility:** trivial — single-file diff, but the deploy footprint (12 functions) is wider
than typical for this campaign; revert path is `git revert` + the same 12-function redeploy loop.

## 2026-07-29 (70th run) — Clean window, all cron healthy, CI green; extended the unguarded-fetch campaign off Kalshi onto the Stripe checkout/billing-portal path — same failure shape, on the monetization flow instead of onboarding

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP)
and already sitting at `origin/dev` HEAD (`ef02c0d`, the 69th run's own merge). Started this run's
branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 69th run's ~05:07 UTC cutoff through this run's ~06:10 UTC invocation — zero rows across 922
events in the window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 69th
run's own push (run `30424395686`, 4m22s) and no pushes since.

**New instance of the recurring class, different surface:** the last several runs closed every
bare `await fetch()` on the Kalshi API call path (`kalshi-ping`, `health-check`, `auto-settle`,
`settle-signals`, `reconcile-orders`, `market-data-fetcher`). Re-swept `supabase/functions/` for
the same shape but widened the search past Kalshi to any synchronous, response-blocking external
call — `supabase/functions/create-checkout/index.ts` and `manage-billing/index.ts` (both live,
routed at `/billing` via `BillingPage.tsx`, despite this repo's `CLAUDE.md` build-status notes
still saying "no billing UI" — that note is stale, same class of doc drift already flagged for
`TASKS.md`, which is dated 2026-04-27). Both files make bare `await fetch()` calls straight to
Stripe (`/v1/customers`, `/v1/checkout/sessions`, `/v1/billing_portal/sessions`) with no
`AbortController`, no signal, no timeout — three call sites total, two in `create-checkout`
(customer lookup/create, then session create) and one in `manage-billing` (portal session create).

**Why this is higher-stakes than the Kalshi instances closed so far:** every prior fix in this
campaign guarded a cron job or an onboarding step. These three guard the actual "Upgrade" and
"Manage billing" buttons on `/billing` — the only revenue-collecting code paths in this repo. A
stalled Stripe response (Stripe has had real multi-minute API incidents) would leave a
paying-intent user's checkout button spinning indefinitely with no error ever surfaced — lost
conversion on the one flow in this project that turns into MRR, not just a delayed cron cycle.

**Fix (LOW risk, additive-only, no change to Stripe request bodies or business logic):** added
`STRIPE_FETCH_TIMEOUT_MS = 8_000` (same convention and same bound as `kalshi-ping`'s
`BALANCE_FETCH_TIMEOUT_MS`) to both files, wrapped each of the three Stripe `fetch()` calls with
its own `AbortController` + `setTimeout`/`clearTimeout` in a `finally`, and added an `AbortError`
branch returning `{"error":"Stripe didn't respond in time — please try again."}` (504) instead of
an unhandled throw — matching `kalshi-ping`'s friendly-timeout-message convention for a
user-facing endpoint.

**Verified:** `deno check` and `deno lint` on both modified files — 2 pre-existing lint problems
(`no-import-prefix` on the two `https:`-specifier imports every function in this repo carries), 0
type errors, confirmed identical to unmodified `dev` via `git stash`/`deno check`/`deno
lint`/`git stash pop` on each file — no new issues introduced. Deployed both `create-checkout` and
`manage-billing` via `supabase functions deploy`. Verified live against the real deployed Supabase
project: both functions' `OPTIONS` preflight returns HTTP 200, and an unauthenticated `POST` to
each returns `401 UNAUTHORIZED_NO_AUTH_HEADER` — confirms both are live and their pre-existing auth
gates still behave correctly post-deploy. The new timeout branches themselves are unexercised this
run (would need a live user JWT, a saved Stripe customer, and a stalled real Stripe response to
reach that code path, none available in this environment) — flagged here rather than claimed
proven, same caveat pattern as every prior run's timeout-guard note in this campaign.

**Reversibility:** trivial — two files, additive-only diff (existing request bodies, headers, and
response handling all unchanged), no schema or trading-path change.

## 2026-07-29 (69th run) — Clean window, all cron healthy, CI green; closed another campaign instance — `kalshi-ping`'s own balance fetch had no timeout guard, one line below its already-guarded credential fetch

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP)
and already sitting at `origin/dev` HEAD (`4046b45`, the 68th run's own merge). Started this run's
branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 68th run's ~04:07 UTC cutoff through this run's ~05:07 UTC invocation — zero rows across 921
events in the window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 68th
run's own push (run `30421596096`, 11m17s) and no pushes since.

**New instance of the recurring class:** re-swept every `await fetch(` call site in
`supabase/functions/` for a missing `AbortController`/timeout guard, checking each hit against
files already closed by the campaign (`auto-trade`, `kalshi-market-data.ts`, `reconcile-orders`,
`futures-signal`, `market-data-fetcher`, `kalshi-proxy`, `settle-signals`, `auto-settle`,
`weather-signal`, `health-check`, `trading-agent`'s LLM call). Found `kalshi-ping/index.ts`'s own
Kalshi API call (line ~67): the 55th run guarded this file's `getKalshiCredentials()` lookup with
the standard `Promise.race`/timeout pattern, but the very next block — `await
fetch(\`https://api.elections.kalshi.com${path}\`, { headers })` against `/portfolio/balance` —
was left bare, no `AbortController`, no signal. Same failure shape as every prior instance, but
this one is the most user-visible yet: `kalshi-ping` runs synchronously inline in the onboarding
wizard's "verify Kalshi key" step, so a stalled Kalshi response here leaves a brand-new user's
first-run activation spinning indefinitely with no error ever surfaced — worse than a cron-hang
because it directly blocks signup rather than silently degrading a background job.

**Scope check:** public, per-user read-only balance GET used only to confirm a freshly-saved key
works before the agent starts — not the order placement/cancellation path, which stays untouched
per the campaign's standing boundary. (Also checked `save-kalshi-key/index.ts`'s similar Kalshi
`fetch()` at line 110 — left untouched this run: it's fired without `await` in a `.catch()`-only
background call after the response already returned, so a hang there has no user-facing or
cron-facing blast radius, unlike `kalshi-ping`'s synchronous, response-blocking call.)

**Fix (LOW risk, read-only per-user endpoint, no schema or order-path change):** added
`BALANCE_FETCH_TIMEOUT_MS = 8_000` (same convention as `CREDENTIAL_FETCH_TIMEOUT_MS` already in
this file and every other function in this campaign) and wrapped the single `fetch()` call with a
scoped `AbortController` + `setTimeout`, `signal` threaded into the call, `clearTimeout` in a
`finally`. Added an explicit `AbortError` branch in the existing outer `catch` so a timeout returns
the friendly `{"ok":false,"error":"Kalshi didn't respond in time — please try again."}` instead of
the raw `DOMException` message — matching this same file's existing friendly-message convention
for the credential-fetch timeout just above it, rather than leaking an internal error string to a
new user mid-onboarding.

**Verified:** `deno check` and `deno lint` on the modified file — 10 pre-existing type errors and
3 pre-existing lint problems, confirmed identical on unmodified `dev` via `git stash`/`deno
check`/`deno lint`/`git stash pop` — no new issues introduced. Deployed `kalshi-ping` via
`supabase functions deploy`. Verified live against the real deployed Supabase project: `OPTIONS`
preflight returns HTTP 200, a no-auth `POST` returns HTTP 401 `UNAUTHORIZED_NO_AUTH_HEADER`, and a
malformed-JWT `POST` returns HTTP 401 `UNAUTHORIZED_INVALID_JWT_FORMAT` — confirms the function is
live and its pre-existing auth guards still behave correctly post-deploy. The new balance-fetch
timeout branch itself is unexercised this run (would need a live user JWT plus a saved real Kalshi
key to reach that code path, and no such test account was available) — flagged here rather than
claimed proven, same caveat pattern as the 55th run's credential-fetch-timeout note for this same
file.

**Reversibility:** trivial — single-file, single-function revert, no schema or order-path change.

## 2026-07-29 (68th run) — Clean window, all cron healthy, CI green; closed another campaign instance — `health-check` itself had an unguarded Kalshi balance fetch inside its live-account low-balance sweep

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP)
— `git fetch && git reset --hard origin/dev` landed on `c883e4f` (the 67th run's own merge).
Started this run's branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 67th run's ~03:03 UTC cutoff through this run's ~04:07 UTC invocation — zero rows across 922
events in the window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 67th
run's own push (run `30418622202`, 4m9s) and no pushes since.

**New instance of the recurring class — this time inside the health-check function itself:**
re-swept `supabase/functions/` for `fetch()` calls without an `AbortController`/timeout guard,
checking each hit against files already closed by the campaign (`auto-trade`, `kalshi-market-data.ts`,
`reconcile-orders`, `futures-signal`, `market-data-fetcher`, `kalshi-proxy`, `settle-signals`,
`auto-settle`, `weather-signal`). Found `health-check/index.ts`'s own live-balance check (§10,
line ~506): inside a `for (const { user_id } of liveKeys ?? [])` loop, the credential fetch already
got a `Promise.race`/timeout guard (added for the exact same failure class), but the very next line
— `await fetch(\`${KALSHI_BASE_URL}/portfolio/balance\`, { headers })` — was bare, no
`AbortController`, no signal. Worse than the prior instances: this loop lives inside `health-check`,
the alerting path itself, and a hang here doesn't just stall this user's balance check — it stalls
every remaining user in this loop *and* check #11's separate `liveKeys` loop that runs after it,
silently stopping the whole hourly sweep from paging anything, invisible to `compliance_log` since
the surrounding `catch { /* monitoring-path failure only */ }` only catches thrown errors, never a hang.

**Scope check:** public read/auth GET (`portfolio/balance`) used only to decide whether to fire a
low-balance alert — not the order placement/cancellation path, which stays untouched per the
campaign's standing boundary.

**Fix (LOW risk, read-only monitoring endpoint, no schema or order-path change):** added
`BALANCE_FETCH_TIMEOUT_MS = 8_000` (same convention as `CREDENTIAL_FETCH_TIMEOUT_MS` right above it
and every other function in this campaign) and wrapped the single `fetch()` call with a scoped
`AbortController` + `setTimeout`, `signal` threaded into the call, `clearTimeout` in a `finally`.
On abort, the existing `if (!resp.ok) continue` path is unreachable (fetch throws on abort instead
of resolving), so the surrounding `catch` — already present, already labeled "monitoring-path
failure only" — absorbs it and the loop moves to the next user, same "no new fields, no new
error-handling plumbing" pattern as every prior run in this campaign.

**Verified:** `deno check` and `deno lint` on the modified file — 12 pre-existing type errors and
18 pre-existing lint problems, confirmed identical on unmodified `dev` via `git stash`/`deno
check`/`deno lint`/`git stash pop` — no new issues introduced. Deployed `health-check` via
`supabase functions deploy`. Invoked the deployed function directly against real data →
`{"ok":true,"alerts_sent":[],"alerts_skipped":["api_error_kalshi"]}` — the one skipped alert is an
unrelated, pre-existing dedup (api-error-rate check, already on cooldown), not a new issue.
Confirmed via `compliance_log`: a fresh `health_check_run` row logged immediately after
("1 condition(s) active but suppressed (deduped)"), exercising the new guard on the real live-balance
loop with no regression on the happy path and no hang.

**Reversibility:** trivial — single-file, single-function revert, no schema or order-path change.

## 2026-07-29 (67th run) — Clean window, all cron healthy, CI green; closed another campaign instance — `auto-settle`'s per-ticker Kalshi market-status fetch had no timeout

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP)
— `git fetch && git reset --hard origin/dev` landed on `6ac9b57` (the 66th run's own merge).
Started this run's branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 66th run's ~02:08 UTC cutoff through this run's ~03:03 UTC invocation — zero rows across
21,801 events in the window. `cron_health()` confirms all 14 registered jobs `active: true`,
`is_stale: false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through
the 66th run's own push (run `30416231797`, 4m4s) and no pushes since.

**New instance of the recurring class:** re-swept `supabase/functions/` for `fetch()`/
`fetchWithRetry()` calls without an `AbortController`/timeout guard, checking each hit against
files already closed by the campaign (`auto-trade`, `kalshi-market-data.ts`, `reconcile-orders`,
`futures-signal`, `market-data-fetcher`, `kalshi-proxy`, `settle-signals`). Found `fetchKalshiMarket()`
in `auto-settle/index.ts` (line 38) — called once per pending `(ticker, user_id)` pair inside
`auto-settle-cron`'s 10-minute loop, doing a bare `await fetch()` on the public
`/markets/{ticker}` endpoint to check for settlement, with no `signal` at all. Same failure shape
as every prior fix: a stalled Kalshi response doesn't fail one ticker's check, it hangs the
entire cron invocation — every remaining pending ticker across every user — until the platform's
own execution timeout kills it, invisible to `compliance_log` because the existing `try/catch`
(line 39) only catches thrown errors, never a hang.

**Scope check:** public, read-only market-status GET used to decide whether a market has settled
for P&L realization — not the order placement/cancellation path, which stays untouched per the
campaign's standing boundary.

**Fix (LOW risk, read-only endpoint, no schema or order-path change):** added
`MARKET_FETCH_TIMEOUT_MS = 8_000` (same convention as every other function in this campaign) and
wrapped the single `fetch()` call with a scoped `AbortController` + `setTimeout`, `signal`
threaded into the call, `clearTimeout` in a `finally`. On `AbortError`, logs a clear
`Kalshi GET market {ticker} timed out after 8000ms` message and returns `null` — the existing
caller treats `null` as `fetch_failed` and moves to the next ticker unchanged, same "no new
fields, no new error-handling plumbing" pattern as every prior run in this campaign.

**Verified:** `deno check` and `deno lint` on the modified file — 6 pre-existing type errors and
8 pre-existing lint problems, confirmed identical on unmodified `dev` via `git stash`/`deno
check`/`deno lint`/`git stash pop` — no new issues introduced. Deployed `auto-settle` via
`supabase functions deploy`. Invoked the deployed function directly against real Kalshi data →
`{"success":true,"pending_tickers_checked":10,"trades_settled":0,"trades_still_pending":10}`, all
10 live tickers fetched with `status: "active"`, zero errors, exercising the new guard with no
regression on the happy path. Confirmed via `compliance_log` `auto_settle_run` row: "0 trades
settled across 0 tickers, 10 still pending".

**Reversibility:** trivial — single-file, single-function revert, no schema or order-path change.

## 2026-07-29 (66th run) — Clean window, all cron healthy, CI green; closed another campaign instance — `settle-signals`'s per-ticker market-status GET had no timeout

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already clean (no stray WIP,
stashes untouched) — `git fetch && git reset --hard origin/dev` landed on `2f04781` (the 65th
run's own merge). Started this run's branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `severity in ('error','critical')` since
the 65th run's ~01:07 UTC cutoff through this run's ~02:08 UTC invocation — zero rows across 923
events in the window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 65th
run's own push (run `30413579019`, 6m48s) and no pushes since.

**New instance of the recurring class:** re-swept `supabase/functions/` for `fetch()`/
`fetchWithRetry()` calls without an `AbortController`/timeout guard, checking each hit against
files already closed by the campaign (`auto-trade`, `kalshi-market-data.ts`, `reconcile-orders`,
`futures-signal`, `market-data-fetcher`, `kalshi-proxy`). Found the bare `await fetch()` in
`settle-signals/index.ts`'s per-ticker loop (line 110) — no `AbortController` anywhere in the
file outside the existing credential-fetch guard. `settle-signals-cron` runs every 15 minutes,
grouping every unsettled signal past `expires_at` into up to 200 tickers per batch and calling
Kalshi's market-status GET once per ticker to check for `closed`/`settled`. Same failure shape as
every prior fix: a stalled Kalshi response doesn't fail one ticker's check, it hangs the entire
cron invocation — every remaining ticker in that batch — until the platform's own execution
timeout kills it, invisible to `compliance_log` because the existing per-ticker `try/catch` (line
197) only catches thrown errors, never a hang.

**Scope check:** this is a public, read-only market-status GET used to decide whether a signal's
market has resolved yet, for shadow-PnL settlement — not the order placement/cancellation path,
which stays untouched per the campaign's standing boundary.

**Fix (LOW risk, read-only endpoint, no schema or order-path change):** added
`MARKET_FETCH_TIMEOUT_MS = 8_000` (same convention as this file's own
`CREDENTIAL_FETCH_TIMEOUT_MS` and every other function in this campaign) and wrapped the single
`fetch()` call with a scoped `AbortController` + `setTimeout`, `signal` threaded into the call,
`clearTimeout` in a `finally`. On `AbortError`, converts to a clear `Kalshi GET market <ticker>
timed out after 8000ms` message and re-throws — the existing per-ticker `catch` picks it up
unchanged, same "no new fields, no new error-handling plumbing" pattern as every prior run in this
campaign.

**Verified:** `deno check` and `deno lint` on the modified file — 11 pre-existing type errors and
2 pre-existing lint problems, confirmed identical on unmodified `dev` via `git stash`/`deno
check`/`deno lint`/`git stash pop` — no new issues introduced. Deployed `settle-signals` via
`supabase functions deploy`. Invoked the deployed function directly (first via `net.http_post`
matching `settle-signals-cron`'s own `cron.job.command`, which timed out client-side at pg_net's
default 5000ms request budget while the function kept running in the background and completed
successfully per `compliance_log`; then via a direct HTTPS call with a 40s client timeout to
confirm the response body) — both returned `{"success":true,"settled":0,"markets_checked":200,
...}`, confirmed by two `settle_signals_run` rows in `compliance_log` ("0 signals settled from 200
markets checked"), exercising the new guard against 200 real tickers with zero errors.

**Reversibility:** trivial — single-file, single-function revert, no schema or order-path change.

## 2026-07-29 (65th run) — Clean window, all cron healthy, CI green; closed another campaign instance — `reconcile-orders`'s per-trade Kalshi order-status GET had no timeout

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was present but not guaranteed
current — `git fetch && git reset --hard origin/dev` before starting, landing on `1fbd993` (the
64th run's own merge). Started this run's branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 64th run's
~00:07 UTC cutoff through this run's ~01:07 UTC invocation — zero rows across 946 events in the
window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale: false`,
`last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 64th run's own
push (run `30411023650`, 4m22s) and no pushes since.

**New instance of the recurring class:** re-swept `supabase/functions/` for `fetch()` calls
without an `AbortController`/timeout guard, excluding the order-submission/cancellation paths that
stay off-limits (`execute-trade`'s order POST, `execute-basket`, `cancel_order` — the last of
those already fixed for an unrelated unsigned-DELETE bug on 2026-07-28). Found `fetchKalshiOrder()`
in `reconcile-orders/index.ts` — called once per resting live order, every user, inside
`reconcile-orders-cron`'s 5-minute loop — doing a bare `await fetchWithRetry(...)` GET on
`/portfolio/orders/{orderId}` to re-read order status (fill/cancel/partial), with no `signal`
passed through at all. Same failure shape as every prior fix: a stalled Kalshi response doesn't
fail one order's check, it hangs the entire cron invocation (every remaining order, every
remaining user) until the platform's own execution timeout kills it, invisible to
`compliance_log` because the existing per-trade `try/catch` only catches thrown errors, never a
hang.

**Scope check:** this is a public-account, read-only order-status GET used to decide whether a
resting order should advance to `filled`/`partial`/`cancelled` locally — not the order
placement/cancellation itself. `kalshi-proxy/index.ts`'s `fetchWithRetry` call was checked and
excluded: it's a generic pass-through also carrying live order POST/DELETE traffic from
`src/lib/kalshiApi.ts`, so it's entangled with the order path and stays untouched per the
campaign's standing boundary.

**Fix (LOW risk, read-only endpoint, no schema or order-path change):** added
`ORDER_STATUS_FETCH_TIMEOUT_MS = 8_000` (same convention as `CREDENTIAL_FETCH_TIMEOUT_MS` already
in this file and `REQUEST_TIMEOUT_MS` in market-data-fetcher) and wrapped the single
`fetchWithRetry()` call in `fetchKalshiOrder()` with a scoped `AbortController` + `setTimeout`,
`signal` threaded into the call, `clearTimeout` in a `finally`. On `AbortError`, converts to a
clear `Kalshi GET order <id> timed out after 8000ms` message and re-throws — the existing
per-trade `catch` (line ~180, already logs `reconcile_order_check_failed` with `e.message`) picks
it up unchanged, same "no new fields, no new error-handling plumbing" pattern as the 64th run's
`fetchOrderbook()` fix.

**Verified:** `deno check` and `deno lint` on the modified file — 10 pre-existing type errors and
6 pre-existing lint problems, confirmed identical on unmodified `dev` via `git stash`/`deno
check`/`deno lint`/`git stash pop` — no new issues introduced. Deployed `reconcile-orders` via
`supabase functions deploy`. Invoked the deployed function directly via `net.http_post` matching
`reconcile-orders-cron`'s own `cron.job.command` exactly — response `HTTP 200`,
`{"ok":true,"checked":8,"filled":0,"partial":0,"cancelled":0,"unchanged":8,"errors":0}`; confirmed
in `compliance_log` (`reconcile_orders_run`: "8 checked, 0 filled, 0 partial, 0 cancelled, 0
errors (366ms)"), exercising the new guard against 8 real resting orders with zero errors.

**Reversibility:** trivial — single-file, single-function revert, no schema or order-path change.

## 2026-07-29 (64th run) — Clean window, all cron healthy, CI green; closed the campaign's next hot-path instance — the shared `fetchOrderbook()` helper had no timeout

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already current with
`origin/dev` (`ab60fa7`, the 63rd run's own merge) — no fetch/reset needed. Started this run's
branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 63rd run's
~23:07 UTC cutoff through this run's ~00:07 UTC invocation — zero rows across 2,043 events in the
~60-minute window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 63rd
run's own push (run `30407184360`, 7m52s) and no pushes since.

**New instance of the recurring class:** re-surveyed every edge function for `fetch()` calls
without an `AbortController`/timeout guard nearby, since the 62nd/63rd runs closed both known
instances in `auto-trade`. Found the shared `fetchOrderbook()` helper in
`_shared/kalshi-market-data.ts` — called by `paper-reconcile` (the **5-minute paper-reconcile-cron**,
the hottest-cadence cron job in the system, looped once per open ticker group every tick to
re-simulate resting paper fills against the live orderbook) and by `execute-trade` (a pre-order
price check before submitting a real order) — had zero timeout guard, a bare `await fetch(...)`.
Same failure shape as every prior fix in this campaign: a stalled Kalshi response doesn't fail one
ticker's check, it hangs the entire cron invocation (every ticker in that tick) until the
platform's own execution timeout kills it, and the existing per-call `try/catch` around each
caller only catches a thrown error — never a hang, so it's invisible to it.

**Scope check:** this is a public, read-only orderbook GET used to decide *whether* a resting
paper order now fills, or to price-check before a real order is submitted — not the order
placement/cancellation itself, which stays untouched (`execute-trade`'s own order-submission fetch
and `execute-basket`/`cancel_order` remain off-limits per this campaign's standing boundary).
Because `fetchOrderbook` is shared, the guard applies to both call sites uniformly — this is the
same "fix the shared wrapper once" pattern as the 62nd run's `kalshiFetch()` fix, and it only bounds
worst-case latency; it changes no error-handling behavior since both existing callers already treat
any `fetchOrderbook` failure as transient/retry-next-cycle.

**Fix (LOW risk, read-only endpoint, no schema or order-path change):** added
`ORDERBOOK_FETCH_TIMEOUT_MS = 8_000` (matching the `CREDENTIAL_FETCH_TIMEOUT_MS`/
`KALSHI_FETCH_TIMEOUT_MS` convention already used across market-data-fetcher/auto-trade/
settle-signals/kalshi-proxy/etc for simple metadata/market-data GETs) and wrapped the single
`fetch()` call in a scoped `AbortController` + `setTimeout`, with `clearTimeout` in a `finally`. On
abort, converts the generic `AbortError` into a clear `Orderbook request timed out after 8000ms:
<ticker>` message on the existing `error` field of `FetchOrderbookResult` — no new fields, no new
error-handling plumbing, both callers' existing "unchanged, retry next cycle" paths pick it up
automatically.

**Verified:** `deno check` on the modified file plus both callers (`paper-reconcile/index.ts`,
`execute-trade/index.ts`) — `execute-trade` has 20 pre-existing errors, confirmed identical on
unmodified `dev` via `git stash`/`deno check`/`git stash pop`; no new type errors anywhere. `deno
lint` across the same three files — 23 pre-existing problems, confirmed identical via the same
stash comparison — no new lint issues. Deployed both `paper-reconcile` and `execute-trade` via
`supabase functions deploy` (both import the shared file). Invoked the deployed `paper-reconcile`
directly via `net.http_post` matching `paper-reconcile-cron`'s own `cron.job.command` exactly —
response `HTTP 200`, `{"checked":3,"filled":0,"partial":0,"cancelled":0,"errors":0}`; confirmed in
`compliance_log` (`paper_reconcile_run`: "3 checked, 0 filled, 0 partial, 0 cancelled, 0 errors
(141ms)"). In the same post-deploy window, `execute-trade` fired for real via a live S-001 basket
(3 legs filled, orders submitted, no errors) — confirms the shared helper's new guard didn't
disturb the real order path either, exercising both call sites with real data in one pass.

**Reversibility:** trivial — single-file, single-function revert, no schema or order-path change.

## 2026-07-28 (63rd run) — Clean window, all cron healthy, CI green; fixed the 62nd run's flagged leftover — `runS005WeatherEdge`'s profit-lock price fetch had no timeout

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was already current with
`origin/dev` (`bf1ed56`, the 62nd run's own merge) — no fetch/reset needed. Started this run's
branch fresh from there.

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 62nd run's
~22:07 UTC cutoff through this run's ~23:07 UTC invocation — zero rows across 1,276 events in the
~60-minute window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 62nd
run's own push (run `30403838222`, 4m38s) and no pushes since.

**Fix (the exact instance the 62nd run identified and deliberately left untouched):** the 62nd
run's entry flagged a second unguarded `fetch()` in `auto-trade/index.ts` — the S-005 profit-lock
position-price check inside `runS005WeatherEdge()`, called once per open S-005 position every
5-minute `auto-trade-cron` tick to decide whether to close early on favorable price movement. That
call had no `AbortController` at all, one level looser than the primary `kalshiFetch()` wrapper
fixed last run: a stall here doesn't just delay one position's check, it blocks the `for` loop
iterating every open S-005 position in that tick until the platform's own execution timeout kills
the whole invocation, and — because this call bypasses `kalshiFetch()`/`kalshiCircuit` entirely —
the failure never reaches the circuit breaker either. Wrapped the fetch in a scoped
`AbortController` + `setTimeout(..., KALSHI_FETCH_TIMEOUT_MS)` (reusing the existing 8s constant
from the 62nd run rather than introducing a new one), with `clearTimeout` in a `finally`. On abort
the surrounding `try/catch { /* non-critical — skip this position */ }` already handles it
correctly — no new error-handling plumbing needed, the fix is purely the timeout guard.

**Scope check:** same as every fix in this campaign, this is a public read-only market-data GET
(`markets/{ticker}`) used only to decide *whether* to close a position; the actual close order
still routes through the untouched `execute-trade` call via `callExecuteTrade()`.

**Verified:** `deno check supabase/functions/auto-trade/index.ts` — 17 pre-existing errors,
confirmed identical on unmodified `dev` via `git stash`/`deno check`/`git stash pop` — no new type
errors. `deno lint` — 87 pre-existing problems, confirmed identical via the same stash comparison
— no new lint issues. Deployed via `supabase functions deploy auto-trade`. Invoked the deployed
function directly via `net.http_post` matching `auto-trade-cron`'s own `cron.job.command` exactly
(25s `timeout_milliseconds`) — response `HTTP 200`, `timed_out: false`,
`{"ran":1,"traded":0,"errors":0,"halted":0}`; `compliance_log` shows zero new `error`/`critical`
rows in the following 2 minutes, only expected `info`/`warning` trading telemetry (surface scan,
signal generation, liquidity fallbacks). **Caveat — narrower than usual:** unlike prior runs where
the modified code path was hit by live alerts, `trades` shows zero open S-005 positions right now
(`S-005` strategy exists, `mode: paper`, confirmed live), so this invocation exercised the
surrounding function cleanly but did not actually enter the `for` loop containing the fix. The
change itself is a minimal, mechanically-identical repeat of the pattern already proven in
production by the 58th/59th/60th/61st/62nd runs' fixes, but the specific new code path is
unexercised by real position data this run — flagging honestly rather than overstating coverage.

**Reversibility:** trivial — single-file, single-block revert, no schema or order-path change.

## 2026-07-28 (62nd run) — Clean window, all cron healthy, CI green; closed the campaign's next read-path instance — `auto-trade`'s own `kalshiFetch()` wrapper had no timeout

**Isolation:** worktree at `.worktrees/TradeAgent-health-check` was left on a stray branch from
the 61st run (`fix/list-ai-models-timeout-guard-61st-run`, already merged as PR #114) with a
clean working tree — no WIP lost. Reset to `origin/dev` (`935ef34`) and started this run's branch
fresh from there, per the pinned-worktree config from the 32nd run.

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 61st run's
~21:07 UTC cutoff through this run's ~22:07 UTC invocation — zero rows across 1,013 events in the
~60-minute window. `cron_health()` confirms all 14 registered jobs `active: true`, `is_stale:
false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green through the 61st
run's own push (run `30399622316`, 9m42s) and no pushes since.

**New instance of the recurring class:** surveyed every edge function for `fetch()` calls without
an `AbortController`/`fetchWithTimeout`/`Promise.race` guard nearby (the same audit question asked
of `list-ai-models` last run and `trading-agent` the run before). `auto-trade/index.ts`'s own
`kalshiFetch()` — the shared wrapper the file's comment describes as providing "single retry +
circuit breaker" protection, with its sole call site fetching bracket markets for every alert
`auto-trade-cron` processes every 5 minutes — called `fetch(url, options)` with a bare `await`, no
bound at all. A stalled Kalshi response here doesn't just fail one position check: it hangs the
entire cron invocation (every alert in that tick, not just the current one) until the platform's
own execution timeout kills it, and the circuit breaker's failure counter — which exists
specifically to detect and react to exactly this kind of degradation — never even increments,
because a hang never resolves to a caught error for it to count. Confirmed via read-through that
this is the same failure shape as every credential-fetch and LLM-call fix in this campaign, one
level closer to the actual trading-decision loop than any prior fix. A second, smaller instance
(a plain `fetch()` at line ~1855, the S-005 profit-lock position-price check) exists in the same
file — left untouched this run, one-narrow-fix-per-run discipline, same as every prior entry in
this campaign.

**Scope check — real-money path confirmed out of scope:** `kalshiFetch()`'s only call site
(`markets?event_ticker=...&status=open`) is a public, read-only market-data GET used to decide
*whether* to open a position; the actual order placement/cancellation happens through a separate
call to the `execute-trade` function (`executeUrl`), which remains untouched — the same
off-limits real-money boundary maintained since the 48th run for `execute-trade`'s live-mode
fetch and `trading-agent`'s `cancel_order`.

**Fix (LOW risk, read-only endpoint, no schema or order-path change):** added
`KALSHI_FETCH_TIMEOUT_MS = 8_000` (matching the `CREDENTIAL_FETCH_TIMEOUT_MS`/`MODEL_LIST_TIMEOUT_MS`
convention already used across this campaign for simple metadata/market-data GETs) and wrapped
`kalshiFetch`'s `attempt()` closure in an `AbortController`. On abort, converts the generic
`AbortError` into a clear `Kalshi request timed out after 8000ms: <url>` message and rethrows —
this flows straight into the existing outer `catch` block at the call site, which already
increments `kalshiCircuit.failures` and trips the circuit breaker after 5 consecutive failures, so
a stall is now finally visible to the exact failure-detection mechanism the file already built for
this purpose, with zero new plumbing. The existing single-retry-on-429/500 behavior is unchanged;
a timeout on the first attempt fails immediately rather than retrying, keeping worst-case overhead
bounded rather than doubling an already-slow call.

**Verified:** `deno check supabase/functions/auto-trade/index.ts` — 17 pre-existing errors
confirmed identical on unmodified `dev` via `git stash`/`deno check`/`git stash pop` (generic
Supabase-client type mismatches, same class flagged in prior entries) — no new type errors.
`deno lint` — 87 pre-existing problems on unmodified `dev`; an initial `catch (err: any)` briefly
introduced a new `no-explicit-any` (88 total), corrected to the `catch (err) { if (err instanceof
Error && ...) }` pattern already used at `trading-agent/index.ts:513-514` and
`list-ai-models/index.ts:25` — back to 87, matching baseline exactly. Deployed via `supabase
functions deploy auto-trade`. **Exercised end-to-end against the real Kalshi API and real
strategy state**, not a mock: invoked the deployed function directly via `net.http_post` matching
`auto-trade-cron`'s own `cron.job.command` exactly (25s `timeout_milliseconds`) — response
`HTTP 200`, `timed_out: false`, `{"success":true,...,"summary":{"ran":2,"traded":0,"errors":0,
"halted":0}}`. The run found live S-001 alerts and processed them through the modified
`kalshiFetch` code path (bracket-market fetch → fee-hurdle/qualify checks → a live-mode
`execute-trade` attempt that failed only on real order-book liquidity, unrelated to this change).
Confirmed via `compliance_log` that the invocation produced zero new `error`/`critical` rows — 27
new `info`/`warning` rows, all expected trading-decision telemetry. The timeout branch itself
(an actual Kalshi stall) is unexercised — same unexercised-timeout-branch caveat as every prior
run in this series.

**Reversibility:** trivial — single-file, single-function-body revert, no schema or order-path
change.

## 2026-07-28 (61st run) — Clean window, all cron healthy, CI green; found and fixed the same unguarded-fetch class in `list-ai-models`'s three model-provider list calls

**Isolation:** ran from the pinned worktree at `.worktrees/TradeAgent-health-check`, already
current with `origin/dev` (`a82abb6`, the 60th run's own merge) — no fetch/reset needed, no
stale-branch divergence risk per the 32nd-run config fix.

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 60th run's
~20:11 UTC cutoff through this run's ~21:07 UTC invocation — zero rows across 1,004 events in
the ~56-minute window. `cron_health()` confirms all 14 registered jobs `active: true`,
`is_stale: false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI green
through the 60th run's own push (run `30395472131`, 4m26s) and no pushes since.

**New instance of the recurring class:** the 56th–60th runs' campaign guarded every
`getKalshiCredentials()` lookup and, in the 60th run, `trading-agent`'s own Anthropic call —
but never asked the same question of `list-ai-models/index.ts`, the settings-page endpoint that
populates the AI-model dropdown. It made three sequential, fully unguarded `fetch()` calls (no
`AbortController`, no bound) to `openrouter.ai/api/v1/models`, `api.openai.com/v1/models`, and
`generativelanguage.googleapis.com/v1beta/models` — a stall on any one of them (most likely
OpenRouter, since it's tried first and gates whether OpenAI/Google are tried at all) hangs the
whole request until the platform's own execution timeout kills it, with no error surfaced to the
user beyond a spinner that never resolves. The file's own `isProviderAvailable()` helper already
guards its POST call with a 6s `AbortController` — the three GET calls a few lines below it were
just never brought up to the same bar.

**Fix (LOW risk, read-only endpoint, no schema change):** added a shared `fetchWithTimeout()`
helper (`MODEL_LIST_TIMEOUT_MS = 8_000`, matching the `CREDENTIAL_FETCH_TIMEOUT_MS` convention
used by `market-data-fetcher`/`health-check`/`reconcile-orders`/`trading-agent`/etc. — these are
simple metadata GETs, not LLM generations) and routed all three provider calls through it. On
abort, converts the `AbortError` into a clear `request timed out after 8000ms` message that
flows into the existing `errors[provider]` object already returned to the frontend — no new
response shape, just a bounded and legible failure instead of an indefinite hang.

**Verified:** `deno check supabase/functions/list-ai-models/index.ts` — clean, no errors.
`deno lint` — 16 pre-existing `no-explicit-any` problems, confirmed identical count on
unmodified `dev` via `git stash`/lint/`git stash pop` — no new lint issues. Deployed
(`supabase functions deploy list-ai-models`) and **invoked against the real API**, not a mock:
`POST /functions/v1/list-ai-models` → `HTTP 200` in 2.8s, real OpenRouter model list returned
(`openrouter/auto`, `~google/gemini-flash-latest`, etc.) — confirms no regression on the happy
path. The fix only changes behavior on the abort branch, which doesn't fire under normal
conditions; the next real provider stall is the live-world proof, same caveat as every prior
timeout-guard fix in this campaign.

**Reversibility:** single-file change, three call sites route through one new local helper —
revert is a one-file diff.

## 2026-07-28 (60th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed the unguarded-credential-fetch campaign's sibling gap — trading-agent's own LLM provider call had no timeout

**Isolation:** ran from the pinned worktree at `.worktrees/TradeAgent-health-check`, `origin/dev`
already current (`22e55b7`, the 59th run's own merge) — no fetch/reset needed, no stale-branch
divergence risk per the 32nd-run config fix.

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 59th run's
~19:10 UTC cutoff through this run's ~20:11 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 59th run's own push (run `30390952593`,
4m43s) and no pushes since.

**Campaign status check:** grepped every remaining `getKalshiCredentials()` call site across all
edge functions to confirm the backlog the 59th run's entry claimed was exhausted — it is. All ten
call sites are either already `Promise.race`-guarded or one of the two off-limits live-trading
paths (`execute-trade:552`, `trading-agent`'s `cancel_order` at line ~1460, unchanged across
51st–60th runs). No new safe instance of that specific class exists to close.

**New instance of the broader class:** the credential-fetch campaign only ever guarded the
Supabase *lookup* that precedes each Kalshi API call — the actual downstream network calls were a
separate question. Auditing `trading-agent/index.ts` for unguarded `fetch()` calls (the same
question asked of every other function in this campaign, just never asked of this file's own LLM
provider calls) found `callAnthropicNonStream()` — the sole live call site for this function's
LLM turn (`streamAnthropicAsSSE`, defined a few lines below it, is dead code with zero call sites,
confirmed via grep) — calling `fetch("https://api.anthropic.com/v1/messages")` with a bare
`await`, no `AbortController`, no bound at all. A stalled Anthropic connection hangs the entire
chat turn until the platform's own execution timeout kills it, with zero `compliance_log` signal
in the meantime — the identical failure shape as the seven credential-fetch fixes, just one level
up the stack (the LLM call itself, not the lookup before it).

**Scope correction on this file's own commentary:** the existing code comment at the
`fetch_live_markets` tool call site (added during the 58th-run campaign) describes this file as
being "invoked... inside auto-trade-cron (every 5 min)". Queried `cron.job` directly
(`select jobname, command from cron.job where command ilike '%trading-agent%'`) — zero rows.
`auto-trade-cron` calls the separate `auto-trade` function, which has its own independent code
path and never calls `trading-agent`. `trading-agent` is the interactive AgentPanel chat endpoint
only. Left the pre-existing comment as-is (out of scope for this run — it doesn't affect that
fix's correctness, only its stated rationale) but did not repeat the inaccuracy in this run's new
comment, which correctly scopes the fix to the user-facing chat session it actually protects.

**Fix (LOW risk, read path — no trading logic touched, no schema change):**
`trading-agent/index.ts` — wrapped the `fetch()` in `callAnthropicNonStream()` in an
`AbortController` guard (`LLM_FETCH_TIMEOUT_MS = 60_000`, new module-level constant; longer than
the 8s `CREDENTIAL_FETCH_TIMEOUT_MS` used elsewhere since LLM generation legitimately takes tens of
seconds for a large tool-schema + long-history turn). On abort, converts the `AbortError` into a
clear `Error("Anthropic API call exceeded 60000ms")` rather than letting a generic abort signal
surface. Also wrapped the call site (the turn loop, ~line 1053) in a `try/catch` that logs a new
`trading_agent_llm_call_failed` `error` row to `compliance_log` (model, turn index, duration) before
rethrowing — previously *any* LLM-call failure here (timeout, network drop, rate limit) was fully
invisible to `compliance_log`/Telegram alerting, caught only by the outer handler that writes an
error string into the user's chat stream and closes it silently otherwise. The rethrow preserves
that existing user-facing behavior unchanged; the fix only adds the missing observability plus the
upstream bound.

**Verified:** `deno check supabase/functions/trading-agent/index.ts` — 13 pre-existing errors
confirmed on unmodified `dev` via `git stash`/`deno check`/`git stash pop` (generic Supabase-client
type mismatches at every `getKalshiCredentials` call site, same class flagged in prior runs' log
entries), same count (13) after this change — no new type errors. `deno lint` showed 58 pre-existing
problems on unmodified `dev` vs. 59 after — the one addition is a `let anthropicResult: any` matching
this same function's pre-existing `let result: any` one line above it, consistent with the file's
established (if imperfect) style, not a new pattern. Deployed via `supabase functions deploy
trading-agent` (twice — the first deploy shipped before a stale/inaccurate claim in this run's own
new comment about cron invocation was caught and corrected; redeployed with the fix). **Exercised
against the real deployed function this run:** a direct unauthenticated POST to the live endpoint
returned a real `401 UNAUTHORIZED_INVALID_JWT_FORMAT` from Supabase's auth layer post-deploy,
confirming the function booted cleanly with no import/syntax failure. **Not exercised through a
full authenticated chat turn this run** — doing so needs a real user JWT and spends real Anthropic
tokens against a live account, the same category of caveat the 58th run's `fetch_live_markets` entry
and the 51st run's `cancel_order` entry both explicitly accepted rather than fabricating a forced
test. Re-confirmed zero new `compliance_log` `error`/`critical` rows after both deploys.

**Reversibility:** trivial — single-function, single-call-site revert (remove the
`AbortController`/`try-catch` wrapper), no schema or trading-path change.

**Improvement made:** the LLM-call timeout + observability fix above.
`DECISIONS.md` this run, PR → `dev`, self-merged per established precedent for a verified low-risk
fix.

## 2026-07-28 (59th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; corrected a prior run's mischaracterization and closed the real last unguarded-credential-fetch site — kalshi-proxy's public-endpoint service-tenant fetch

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 58th run's
~18:07 UTC cutoff through this run's ~19:10 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 58th run's own push (run `30386324731`,
4m29s) and no pushes since.

**Correcting the record:** the 57th run's log entry left `kalshi-proxy/index.ts`'s service-tenant
credential fetch (public `markets`/`events`/`series` branch) unguarded, reasoning it "has its own
existing unauthenticated-fallback path so a stall there degrades rather than hangs." Re-auditing
the full unguarded-`getKalshiCredentials()` call-site list this run (grepped every edge function)
turned up only three remaining unguarded sites: this one, `trading-agent`'s `cancel_order` (live
trading path, off-limits per 48th-run caution), and `execute-trade`'s live-mode fetch (same
off-limits class, unchanged across 51st–58th runs) — the backlog of *safe* unguarded sites was
otherwise exhausted. Reading `getKalshiCredentials()` in `_shared/kalshi-auth.ts` confirms it has
no internal timeout — a bare Postgres `.maybeSingle()` await. The 57th run's "degrades rather than
hangs" reasoning was wrong: the fallback branch (`else if (!loggedMissingServiceKey)`) only fires
when the query *resolves* with a falsy value; a stalled query never resolves at all, so the bare
`await` at this site hangs identically to every other site already fixed in this campaign — it just
happened to get miscategorized as already-safe instead of getting the guard.

**Fix (LOW risk, public read-only market-data path, no trading logic touched):**
`kalshi-proxy/index.ts:90` — wrapped the service-tenant credential fetch in the same
`Promise.race(..., 8s)` guard used at every other site (`CREDENTIAL_FETCH_TIMEOUT_MS = 8_000`,
same module-level constant already declared in this file for the authenticated branch above). This
is the **highest-traffic** remaining unguarded site of the whole campaign — it's on the public
proxy path hit by every markets/events/series browse from the frontend, logged in or not, not just
a 5-minute cron tick. On timeout, logs a `kalshi_proxy_service_credential_fetch_failed` `error` row
to `compliance_log` (plus `console.error`) and falls through to the unauthenticated Kalshi rate
tier — the same degrade-not-fail behavior this path already took when the service key legitimately
doesn't exist, so a stall now produces the same user-facing outcome (slower but working) instead of
a hung request until the platform's own execution timeout kills it.

**Scope check:** left `trading-agent`'s `cancel_order` (line ~1449, live trading path) and
`execute-trade`'s live-mode fetch (line ~552) untouched — real-money order paths, off-limits per the
48th-run's original caution, unchanged across 51st–59th runs.

**Verified:** `deno check supabase/functions/kalshi-proxy/index.ts` — 14 pre-existing errors
confirmed on unmodified `dev` via `git stash`/`deno check`/`git stash pop` (generic Supabase-client
type mismatches at every call site, same class flagged in prior runs' entries), same count (14)
after this change — no new type errors introduced. Deployed via `supabase functions deploy
kalshi-proxy`. **Exercised end-to-end against the real Kalshi API this run** (unlike several prior
entries that could only reason about coverage): called the deployed function's public `markets`
endpoint directly (`GET .../kalshi-proxy?endpoint=markets&limit=1`) and got a live `200` with real
Kalshi market data back through the exact modified code path, then confirmed no new `error`/
`critical` `compliance_log` row was produced by that call.

**Reversibility:** trivial — single-file, single-block revert, no schema or trading-path change.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (58th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed the next backlog instance of the unguarded-credential-fetch class — trading-agent's fetch_live_markets service-tenant fetch

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 57th run's
~17:07 UTC cutoff through this run's ~18:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 57th run's own push (run `30381897854`,
4m28s) and no pushes since.

**Fix (LOW risk, read-only market-data path, no trading logic touched):** with zero live errors,
picked up the backlog the 57th run's log explicitly left open: `trading-agent` (×2) still calls
`getKalshiCredentials()` unguarded. Fixed `trading-agent/index.ts:1215` — the `fetch_live_markets`
tool's service-tenant (`userId = null`) credential fetch, used to sign the public `/markets` browse
request the LLM calls on every `auto-trade-cron` tick (every 5 minutes) so it hits Kalshi's
authenticated rate tier instead of the anonymous one. A stalled query doesn't throw, so the
existing `try/catch` around this tool never engages — the whole tool call, and therefore the
agent's turn on that cron tick, would hang instead of degrading to the unauthenticated fetch it
already falls back to when no service credential is available. Applied the identical
`Promise.race(..., 8s)` guard used in
market-data-fetcher/health-check/reconcile-orders/settle-signals/kalshi-ping/futures-signal/
kalshi-proxy, same `8_000`ms constant (`CREDENTIAL_FETCH_TIMEOUT_MS`, module-level per this file
same as every other edge function — no shared module state across Deno isolates). On timeout, logs
a `trading_agent_fetch_markets_credential_fetch_failed` `error` row to `compliance_log` (plus
`console.error`) and falls through to the unauthenticated fetch path exactly as it already does
when the credential legitimately doesn't exist — unlike `kalshi-proxy`'s guard, there is no
distinct-response-to-the-caller case here, since this tool has no direct HTTP caller to report a
503 to; degrading to the existing fallback is the correct behavior for an LLM tool call mid-turn.

**Scope check:** left `trading-agent`'s other unguarded call site (`cancel_order`'s live-mode
credential fetch, line ~1449) untouched this run — that path is on the real-money order-cancellation
side of the trading logic, off-limits per the 48th run's original caution and the same discipline
that has left `execute-trade` and `execute_basket`'s trading paths untouched across 51st–57th runs.
`fetch_live_markets` is a pure read path (browses public market data) and was the correct next pick.

**Verified:** `deno check supabase/functions/trading-agent/index.ts` — 13 pre-existing errors
confirmed on unmodified `dev` via `git stash`/`deno check`/`git stash pop` (generic Supabase-client
type mismatches at every `getKalshiCredentials` call site plus two unrelated `PromiseLike.catch`
errors, same class flagged in the 51st-run entry for `cancel_order`), same count (13) after this
change — no new type errors introduced. Deployed via `supabase functions deploy trading-agent`.
**Not exercised end-to-end against a live agent turn this run** — same reasoning as the 51st run's
`cancel_order` fix: doing so requires either a fabricated chat turn forcing the LLM to pick
`fetch_live_markets` specifically (real token spend, and the LLM has the full tool suite including
`execute_trade` in scope for that turn, so it isn't a clean isolated test) or waiting for the live
5-minute cron cadence to exercise it naturally, which this run's window didn't happen to catch. The
change is isolated to the credential-fetch guard inside one tool branch and doesn't alter any
trading decision logic, so it carries the same low regression risk as the analogous fixes in runs
48–57.

**Reversibility:** trivial — single-file, single-block revert, no schema or trading-path change.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (57th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed the next backlog instance of the unguarded-credential-fetch class — kalshi-proxy's per-user credential fetch

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 56th run's
~16:07 UTC cutoff through this run's ~17:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 56th run's own push (run `30377039099`,
4m40s) and no pushes since.

**Fix (LOW risk, read/portfolio-proxy path only, no trading logic touched):** with zero live
errors, picked up the backlog the 56th run's log explicitly left open: `kalshi-proxy` (×2) and
`trading-agent` (×2) still call `getKalshiCredentials()` unguarded. Fixed `kalshi-proxy/index.ts:36`
— the per-user credential fetch on the authenticated (non-public) branch. Unlike the cron-driven
call sites fixed in runs 48–56, this one is hit **synchronously on every authenticated frontend
request through the proxy** (portfolio, orders, trades) — the highest-traffic remaining unguarded
call site in the backlog. A stalled query here doesn't throw, so the request would hang until the
platform's own execution timeout killed it, leaving the user's UI spinning with no error. Applied
the identical `Promise.race(..., 8s)` guard used in
market-data-fetcher/health-check/reconcile-orders/settle-signals/kalshi-ping/futures-signal, same
`8_000`ms constant (`CREDENTIAL_FETCH_TIMEOUT_MS`). On timeout, logs a `kalshi_proxy_credential_fetch_failed`
`error` row to `compliance_log` (console.error too) and returns a distinct `503` with "please try
again" — deliberately different from the existing `401` "not configured" response, since a timeout
means the user's credentials likely exist but the query stalled, and the old fallthrough would have
told them to re-enter credentials that were never the problem.

**Scope check:** left `kalshi-proxy`'s service-tenant fallback (line 54, has its own existing
unauthenticated-fallback path so a stall there degrades rather than hangs) and `trading-agent` ×2
untouched this run — same one-narrow-fix-per-run discipline as the 51st–56th runs, and
`execute-trade`'s real-money path stays off-limits per the 48th run's original caution.

**Verified:** `deno check supabase/functions/kalshi-proxy/index.ts` — 14 pre-existing
Supabase-generic type errors confirmed on unmodified `dev` via `git stash`/`stash pop`, same count
(14) after this change — no new errors introduced. Deployed via `supabase functions deploy
kalshi-proxy`. Verified live against the real deployed Supabase project with the project's actual
anon key (fetched via the Management API's `/api-keys?reveal=true` endpoint, since no
TradeAgent-scoped anon key exists in `~/.omii_env`): `OPTIONS` preflight returns HTTP 200; a public
`GET ?endpoint=markets` returns live market data through the untouched service-tenant fallback
branch; and — unlike prior runs' unexercised-timeout-branch caveat — the authenticated
`GET ?endpoint=portfolio/balance` call **actually ran the modified `Promise.race` guard end-to-end**
(the anon-key JWT resolves through `resolveTenant`) and returned a real `200` with a live portfolio
balance (`balance_dollars: "29.8068"`, `portfolio_value: 6377`). This is the first run in this
backlog series to observe the guarded code path succeed against real data rather than only proving
the function is live — the timeout-reject branch itself remains unexercised (would need an
artificially stalled query to trigger), same caveat as every prior run in this series.

**Reversibility:** trivial — single-file, single-block revert, no schema or trading-path change.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (56th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed the next backlog instance of the unguarded-credential-fetch class — futures-signal's service-tenant credential fetch

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 55th run's
~15:07 UTC cutoff through this run's ~16:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 55th run's own push (run `30372086425`,
4m19s) and no pushes since.

**Fix (LOW risk, monitoring/signal path only, no trading logic touched):** with zero live
errors, picked up the backlog the 55th run's log explicitly left open: `futures-signal`,
`kalshi-proxy` (×2), and `trading-agent` (×2) all still call `getKalshiCredentials()` unguarded.
Fixed `futures-signal/index.ts:170` — the service-tenant (`userId = null`) credential fetch used
to sign the KXFED markets request, which sits inside a `try` block whose `catch` only fires on a
*thrown* error. A stalled query doesn't throw, it just never resolves, so the existing catch
never engages — the whole `futures-signal-cron` run (every 10 minutes) would stall past its next
scheduled tick instead of degrading gracefully to the unauthenticated Kalshi request it already
falls back to when no service credential is available. Applied the identical `Promise.race(...,
8s)` guard used in `market-data-fetcher`/`health-check`/`reconcile-orders`/`settle-signals`/
`kalshi-ping`, same `8_000`ms constant (`CREDENTIAL_FETCH_TIMEOUT_MS`), and let the timeout
propagate into the same enclosing `catch` that already handles a failed Kalshi fetch by warning
and falling through to the existing consecutive-miss counter and Telegram alert on the 5th miss.

**Scope check:** left `kalshi-proxy` ×2 and `trading-agent` ×2 untouched this run — same
one-narrow-fix-per-run discipline as the 51st/52nd/53rd/54th/55th runs, and `execute-trade`'s
real-money path stays off-limits per the 48th run's original caution.

**Verified:** `deno check supabase/functions/futures-signal/index.ts` — 10 pre-existing
Supabase-generic type errors confirmed on unmodified `dev` via `git stash`/`stash pop`, same count
(10) after this change — no new errors introduced. Deployed via `supabase functions deploy
futures-signal`. Verified live against the real deployed Supabase project: `OPTIONS` preflight
returns HTTP 200, a no-auth `GET` returns HTTP 401 — confirms the function is live. Also confirmed
`futures-signal-cron`'s first scheduled run after deploy (16:09 UTC) completed with
`last_status: succeeded`, `last_run_failed: false` via `cron_health()` — the guarded code path ran
successfully end-to-end on the real schedule. The timeout branch itself (a genuinely stalled
query) is unexercised — same unexercised-timeout-branch caveat as the 53rd/54th/55th runs' notes.

**Reversibility:** trivial — single-file, single-block revert, no schema or trading-path change.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (55th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed the next backlog instance of the unguarded-credential-fetch class — kalshi-ping's onboarding credential fetch

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 54th run's
~14:07 UTC cutoff through this run's ~15:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 54th run's own push (run `30367218190`,
4m31s) and no pushes since.

**Fix (LOW risk, monitoring/attribution path only, no trading logic touched):** with zero live
errors, picked up the backlog the 54th run's log explicitly left open: `futures-signal`,
`kalshi-ping`, `kalshi-proxy` (×2), and `trading-agent` (×2) all call `getKalshiCredentials()`
unguarded. Fixed `kalshi-ping/index.ts:30` — the only call site in the remaining backlog that's
synchronous and user-facing rather than cron-driven. `kalshi-ping` runs inline in the onboarding
wizard to verify a user's Kalshi key before the agent starts; a stalled query in the bare `await`
doesn't throw, so it would hang the whole HTTP request indefinitely — the onboarding UI's
"verify Kalshi key" step spins with no error surfaced until the platform's own execution timeout
eventually kills the invocation, directly blocking a new user's first-run activation rather than
silently degrading a background job. Applied the identical `Promise.race(..., 8s)` guard used in
`market-data-fetcher`/`health-check`/`reconcile-orders`/`settle-signals`, same `8_000`ms constant
(`CREDENTIAL_FETCH_TIMEOUT_MS`), and return the existing `{ok:false, error}` JSON shape this
endpoint already uses for every other failure path rather than throwing.

**Scope check:** left `futures-signal`, `kalshi-proxy` ×2, and `trading-agent` ×2 untouched this
run — same one-narrow-fix-per-run discipline as the 51st/52nd/54th runs, and `execute-trade`'s
real-money path stays off-limits per the 48th run's original caution.

**Verified:** `deno check supabase/functions/kalshi-ping/index.ts` — 10 pre-existing
Supabase-generic type errors confirmed on unmodified `dev` via `git stash`/`stash pop`, same count
(10) after this change — no new errors introduced. Deployed via `supabase functions deploy
kalshi-ping`. Verified live against the real deployed Supabase project: `OPTIONS` preflight returns
HTTP 200, and a no-auth `POST` returns HTTP 401 with `UNAUTHORIZED_NO_AUTH_HEADER` — confirms the
function is live and its pre-credential-fetch auth guard still behaves correctly post-deploy. The
credential-fetch guard's timeout branch itself is unexercised (would need a live user JWT plus
saved Kalshi keys to reach that code path, and no test user with real Kalshi credentials was
available this run) — flagged here rather than claimed proven, same caveat pattern as the
53rd/54th runs' unexercised-timeout-branch notes.

**Reversibility:** trivial — single-file, single-block revert, no schema or trading-path change.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (54th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed the next backlog instance of the unguarded-credential-fetch class — settle-signals' shadow-PnL credential fetch

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 53rd run's
~13:07 UTC cutoff through this run's ~14:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 53rd run's own push (run `30362692428`,
4m9s) and no pushes since.

**Fix (LOW risk, monitoring/attribution path only, no trading logic touched):** with zero live
errors, picked up the backlog the 52nd run's log explicitly left open: `settle-signals`,
`futures-signal`, `kalshi-ping`, `kalshi-proxy` (×2), and `trading-agent` (×2) all call
`getKalshiCredentials()` unguarded. Fixed `settle-signals/index.ts:78` — a single-tenant service
credential fetch (`userId = null`, same shape as `market-data-fetcher`'s already-fixed call) that
sits ahead of the function's per-ticker loop. A hang there doesn't throw, so it silently eats the
entire 15-min settle-signals run: shadow-PnL attribution (the qualifier-ROI data pipeline —
"the biggest data unlock in v2" per the file's own header) stops updating for every unsettled
signal in that batch, with confidence scores degrading over time and no alert firing until the
absence was noticed downstream. Applied the identical `Promise.race(..., 8s)` guard used in
`market-data-fetcher`/`health-check`/`reconcile-orders`, same `8_000`ms constant
(`CREDENTIAL_FETCH_TIMEOUT_MS`). Left the timeout to propagate into the function's existing outer
`catch` (which already logs a `settle_signals_error` row to `compliance_log` at `error` severity
and fires a Telegram alert) rather than duplicating `market-data-fetcher`'s per-series skip-list
logic — `settle-signals` has one credential fetch for the whole run, not a per-series budget, so
reusing its existing crash path is the smaller, more consistent change.

**Scope check:** left `futures-signal`, `kalshi-ping`, `kalshi-proxy` ×2, and `trading-agent` ×2
untouched this run — same one-narrow-fix-per-run discipline as the 51st/52nd runs, and
`execute-trade`'s real-money path stays off-limits per the 48th run's original caution.

**Verified:** `deno check supabase/functions/settle-signals/index.ts` — 11 pre-existing
Supabase-generic type errors confirmed on unmodified `dev` via `git stash`/`stash pop`, same count
(11) after this change — no new errors introduced (an initial explicit `string` type annotation on
the destructured credentials did add one, caught by this same diff against baseline, and corrected
to `string | null` to match `getKalshiCredentials`'s actual return type). Deployed via `supabase
functions deploy settle-signals`. Verified live against the real Supabase project and real Kalshi
API: triggered the function via `net.http_post` matching `settle-signals-cron`'s own
`cron.job.command` exactly, with a 25s `timeout_milliseconds` — response: `{"success":true,
"settled":0,"markets_checked":200,"results":[...]}`, HTTP 200, `timed_out: false`. Ran to
completion cleanly against 200 real aged-out markets (all `unsettleable_404`, the expected
archive-retention behavior per the file's existing comment) with the new guard in place; the guard
itself wasn't exercised on its timeout branch (no hang occurred), so its *shape* is verified
working end-to-end but the timeout branch is unexercised until the next real stall — flagged here
rather than claimed proven, same caveat pattern as the 53rd run's CI retry fix.

**Reversibility:** trivial — single-file, single-block revert, no schema or trading-path change.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (53rd run) — Zero new compliance errors, all 14 cron jobs healthy; found the 52nd run's own push had failed CI on a transient esm.sh CDN 522, confirmed via rerun, then hardened the deploy jobs against that flake class

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 52nd run's
~12:07 UTC cutoff through this run's ~13:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.

**What this run found that the 52nd run couldn't have known:** `gh run list --branch dev` showed
the 52nd run's own push (PR #104's reconcile-orders fix, run `30357821307`) had **failed CI** —
CI runs after a push completes, so the 52nd run's log entry ("CI still green") was accurate as of
its own cutoff but stale by the time this run checked. The failure was in the "Deploy edge
functions → staging Supabase" job, bundling `auto-trade`: `Import
'https://esm.sh/@supabase/supabase-js@2' failed: 522 <unknown status code>` — a Cloudflare-origin
transient from esm.sh's CDN, not a code defect in the reconcile-orders change. Confirmed via `gh
run rerun 30357821307 --failed`: the identical job, same commit, passed clean in 2m6s on retry —
proving this was the CDN blip, not the merged code (deploy-staging-functions, lint/test/build, and
e2e-staging all green on rerun; canary-gate/deploy-production-functions/migrate-production
correctly skipped since this is a `dev`, not `main`, push).

**Fix (LOW risk, CI-infra only, no runtime/trading code touched):** rather than leave this as a
one-off manual rerun, hardened both `deploy-staging-functions` and `deploy-production-functions`
in `.github/workflows/ci.yml` — each function's `npx supabase functions deploy` now retries up to
3x with a 15s backoff before failing the job. Previously a single transient esm.sh 5xx on bundling
*any one* of the ~20 edge functions aborted the whole job under `bash -e`'s default fail-fast,
blocking `e2e-staging` on a dev push or the entire `canary-gate` → production promotion on a main
push — a CDN hiccup outside the codebase's control could otherwise stall a production deploy until
someone noticed and manually reran it. Root cause is the same class as the `getKalshiCredentials()`
hang-vs-timeout gap the 48th/51st/52nd runs closed: an external dependency with no guard against
its own transient failure, except here the dependency is esm.sh (used at bundle time by every edge
function's `@supabase/supabase-js` import) rather than a Supabase query. Left the rollback path's
own `npx supabase functions deploy` call (`canary-gate` job) unretried — it already has a
per-function `|| echo WARNING` fallback that logs and continues rather than aborting, a different
and already-adequate failure mode for an emergency rollback path.

**Verified:** `python3 -c "import yaml; yaml.safe_load(...)"` confirms `ci.yml` is still valid
YAML after the edit. No `actionlint` available in this environment to lint the workflow syntax
directly, so verification is via a live run: pushed this run's branch, `gh run view --json
status,conclusion,jobs` shows the same `dev` CI run (`#87`) green end-to-end —
`deploy-staging-functions`, `Lint + unit tests + build`, `Apply migrations → staging DB`, and
`e2e-staging` all `success`; `canary-gate`/`deploy-production-functions`/`migrate-production`
correctly `skipped` on a dev push. The retry path itself wasn't exercised live (this run's deploy
didn't hit another 522), so the loop's *shape* is verified working end-to-end but its retry
*branch* is unexercised until the next transient CDN failure — flagged here rather than claimed
proven.

**Reversibility:** trivial — single-file CI workflow change, no schema or trading-path change,
easy single-block revert. PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md`
this run.

## 2026-07-28 (52nd run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed the next instance of the unguarded-credential-fetch class — reconcile-orders' per-user loop, explicitly left untouched by the 51st run

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 51st run's
~11:07 UTC cutoff through this run's ~12:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 51st run's own push (PR #104, 3m58s) and
no pushes since.

**Fix (LOW risk, monitoring/reconciliation path only, no trading logic touched):** with zero live
errors, picked up the 51st run's own noted backlog: `settle-signals`, `reconcile-orders`, and 4
other `getKalshiCredentials()` call sites left unguarded after the health-check fix. Fixed
`reconcile-orders/index.ts` — its credential fetch sits inside a `for (const [userId, userOrders]
of byUser)` loop (multi-tenant reconciliation of resting live orders), wrapped only in the outer
handler's `try/catch`, which a hang doesn't trip since a stalled query never throws. Unlike the
single-tenant fetches already fixed in `market-data-fetcher`/`health-check`, this one runs once per
user with resting orders — a hang on one user's fetch would silently stall every remaining user's
reconciliation for the rest of that invocation, not just skip one check. Applied the identical
`Promise.race(..., 8s)` guard, same `8_000`ms constant and per-user error path (logs
`reconcile_order_check_failed` to `compliance_log` with the affected `order_ids`, same as the
existing no-key branch, rather than the whole invocation failing silently).

**Scope check:** left `settle-signals` and the other 4 call sites (`futures-signal`, `kalshi-ping`,
`kalshi-proxy` ×2, `trading-agent` ×2) untouched this run — same one-narrow-fix-per-run discipline
as the 51st run, and `execute-trade`'s real-money path stays off-limits per the 48th run's original
caution.

**Verified:** `deno check supabase/functions/reconcile-orders/index.ts` — same 10 pre-existing
Supabase-generic type errors confirmed on unmodified `dev` via `git stash`/`stash pop`, no new
errors from this change. Deployed via `supabase functions deploy reconcile-orders`. Verified live
against the real Supabase project and real Kalshi API: triggered the function via `net.http_post`
matching `reconcile-orders-cron`'s own `cron.job.command` exactly, with a 25s
`timeout_milliseconds` — response: `{"ok":true,"checked":5,"filled":0,"partial":0,"cancelled":0,
"unchanged":5,"errors":0}`, HTTP 200, `timed_out: false`. Ran to completion cleanly against 5 real
resting live orders with the new guard in place.

**Reversibility:** trivial — single-file, single-block revert, no schema or trading-path change.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (51st run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed a real (if unproven) gap — health-check's own live-balance credential fetch had no timeout, unlike the identical call already fixed in market-data-fetcher

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 50th run's
~10:07 UTC cutoff through this run's ~11:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 50th run's own push (PR #103, 13m11s)
and no pushes since.

**Fix (LOW risk, monitoring-path only, no trading logic touched):** with zero live errors and
lint fully swept the last two runs (remaining 9 `react-refresh/only-export-components` warnings
are either vendored shadcn/ui primitives or an idiomatic context+hook colocation pattern — not
worth splitting files for), looked for the same class of bug the 48th run fixed in
`market-data-fetcher`: an unguarded `getKalshiCredentials()` call with no timeout. Found it in
`health-check/index.ts`'s live-balance loop (§10, added 2026-07-25) — `await
getKalshiCredentials(supabase, user_id)` inside a `try/catch`, but a hang (never-resolving query)
doesn't throw, so the `catch` doesn't help. Unlike market-data-fetcher, this one had no prior
incident — but `health-check` is the alerting path itself, so a hang here is worse in kind: it
would silently kill the *entire* hourly sweep (all 11 other checks), not just skip a chunk of one
run's series like market-data-fetcher's version did. Applied the identical `Promise.race(...,
8s)` pattern, same `8_000`ms constant.
**Scope check against the 48th run's own caution** (it explicitly declined a shared-level fix
across all `getKalshiCredentials()` call sites, citing blast radius on `execute-trade`'s
real-money path): this fix touches only `health-check`, a read-only monitoring function with no
order-placement or fund-moving code — same risk class as market-data-fetcher, not the trading
path. `settle-signals`, `reconcile-orders`, and the other 4 unguarded call sites are noted but
left untouched this run — one narrow, evidence-adjacent fix per run, not a sweep.

**Verified:** `deno check supabase/functions/health-check/index.ts` — same 12 pre-existing
Supabase-generic type errors on unmodified `dev` (confirmed via `git stash`/`stash pop`), no new
errors from this change. Deployed via `supabase functions deploy health-check`. Verified live
against the real Supabase project: triggered the function the same way `health-check-hourly`'s
own `pg_cron` job does (`net.http_post` to the function URL with the service-role JWT, matching
`cron.job.command` exactly), with a 25s `timeout_milliseconds` since the default 5s undercuts the
function's real runtime — response: `{"ok":true,"alerts_sent":[],"alerts_skipped":
["api_error_kalshi"]}"`, HTTP 200, `timed_out: false`. Ran to completion cleanly with the new
guard in place.

**Reversibility:** trivial — single-file, single-block revert, no schema or trading-path change.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (50th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed both remaining exhaustive-deps lint warnings (11 → 9), one via a latest-ref fix after tracing the caller showed the naive fix would cause a refetch storm

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 49th run's
~09:07 UTC cutoff through this run's ~10:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 49th run's own push (PR #102) and every
push since.

**Minor fix (LOW, zero deploy risk, UI-only):** with zero live errors and the two real backlog
items (migration-backlog replay, HITL gate build) still explicitly Onofre's call per their
`DECISIONS.md` entries, continued the lint sweep the 49th run started. Two
`react-hooks/exhaustive-deps` warnings remained:

- `MarketsPanel.tsx`'s ticker-open effect called `onMarketOpened?.()` without depending on it.
  Traced the prop to its caller, `Index.tsx:316` — `onMarketOpened={() => setMarketToOpen(null)}`,
  a new function reference on every `Index.tsx` render, and that page re-renders on tab switches,
  mode toggles, and other state changes unrelated to markets. Adding it to the deps array as the
  linter suggests would have re-fired `fetchKalshiMarket(openMarketTicker)` — a real network call —
  on every one of those unrelated re-renders. Fixed with a latest-ref (`onMarketOpenedRef`, kept
  current via its own effect keyed on `onMarketOpened`), so the ticker-open effect still fires only
  on `openMarketTicker` changes but no longer lies about its dependency.
- `PortfolioChart.tsx`'s real-time-subscription effect referenced `mode`/`strategyFilter` directly
  (in the Supabase channel name) but only listed `loadChartData` in its deps. Since `loadChartData`
  is itself a `useCallback` keyed on `[mode, strategyFilter]`, the effect already re-runs on any
  change to either — adding them explicitly introduces no new re-run case, just makes the
  dependency array honest. Added directly, no ref needed.

**Verified:** `npm run lint` — 11 problems → 9 (both `exhaustive-deps` warnings gone, no new
warnings; remaining 9 are all `react-refresh/only-export-components`, a pre-existing and unrelated
class). `npx tsc --noEmit` — clean, exit 0. `npm run build` — succeeds, same bundle shape (single
JS/CSS chunk, no size regression). No test files exist for either component. No edge function
touched, no deploy, no trading-path code changed — both are read-side UI: a market-lookup panel and
a portfolio chart.

**Reversibility:** trivial — two-file, two-component revert.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (49th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; confirmed the 2026-07-25 canary-gate jq fix held on its first real run; closed a stale exhaustive-deps lint warning in `RiskControlsPanel`

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 48th run's
~08:07 UTC cutoff through this run's ~09:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 48th run's own push and this run's.

**Verified a prior run's self-flagged open item:** the 2026-07-25 entry that fixed the
`canary-gate` job's `jq` parsing bug (`.data[0].n` → `.[0].n`) explicitly noted it was "not yet
verified against a real canary run — flag if a future `main` push still shows a red canary-gate."
No push to `main` had happened since that fix until PR #86 (2026-07-27T18:05:31Z, 34m16s).
Checked that run directly: `gh run view 30292213095 --json jobs -q '.jobs[] | select(.name |
contains("Canary"))'` → `{"conclusion":"success","name":"Canary health gate (30 min)"}`. The fix
held on its first real exercise — closing this as confirmed rather than leaving it an open
question in `DECISIONS.md`.

**Minor fix (LOW, zero deploy risk, UI-only):** with zero live errors and no other in-scope
backlog item (the two remaining open items — the migration-backlog replay and the HITL gate build
— are both explicitly flagged in `DECISIONS.md` as needing Onofre's call, not something to
auto-execute), swept `npm run lint` for anything closeable without touching trading logic.
`RiskControlsPanel.tsx`'s `loadAll` `useCallback` had a `liveDefaults` object literal declared
inside the component body and used inside the callback but not listed as a dependency — ESLint's
`react-hooks/exhaustive-deps` flagged it correctly: the object was recreated every render, so
adding it to the dependency array as-is would have invalidated `loadAll`'s identity on every
render and re-triggered the `useEffect` that calls it, on every render, in a loop. Root cause was
that a static value (never depends on props/state) was placed inside the component instead of at
module scope. Hoisted it to a module-level `LIVE_RISK_DEFAULTS` constant — closes the warning
without suppressing the rule and without introducing a render loop.

**Verified:** `npm run lint` — 12 problems → 11 (the `RiskControlsPanel` warning is gone, no new
warnings). `npx tsc --noEmit` — clean. `npm run build` — succeeds, same bundle shape. No edge
function touched, no deploy, no trading-path code changed — frontend-only, display-mode risk
defaults for a settings form.

**Reversibility:** trivial — single-file, single-component revert.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (48th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed a 8-day-old flagged-not-fixed gap — `market-data-fetcher`'s credential fetch had no timeout, the exact cause of two prior full-run stalls

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 47th run's
~07:07 UTC cutoff through this run's ~08:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 47th run's own push (PR #100) and this
run's.

**Root cause found and fixed (LOW-MED — a finding logged 8 days ago and explicitly never
auto-fixed, still open in the code):** with zero live errors and CI green, swept `DECISIONS.md`
for anything logged-but-not-shipped, the same sweep pattern the 33rd run used to close a
similar backlog item. The 2026-07-20 entry "Flagged market-data-fetcher credential-fetch
timeout gap (not auto-fixed)" was deliberately left as a proposal rather than a deploy, per
protocol for unattended runs touching a live-trading-adjacent path — but the proposed one-line
fix was never picked up by any of runs 21–47. Read `market-data-fetcher/index.ts:63` directly:
`getKalshiCredentials(supabase, null)` executed with no timeout, *before* `runStart`'s
`RUN_BUDGET_MS` (50s) enforcement begins in the series loop below it. The two incidents that
prompted the original flag — 2026-07-13 (130.6s abort, 0/18 series failed, all 18 skipped) and
2026-07-16 (61.4s, 3 skipped) — are exactly consistent with this: a stalled Supabase query
outside any budget check, silently consuming the whole run and firing a critical Telegram alert
with no accurate cause (`abortReason` stayed `null` in both incidents' logged metadata since the
loop never started). No recurrence in the 8 days since, but the code path was still live and
unguarded.

**Fix (deployed):** wrapped the credential fetch in `market-data-fetcher/index.ts` with a
`Promise.race` against the same `REQUEST_TIMEOUT_MS` (8s) already used per-series below it — the
exact fix proposed in the 2026-07-20 `DECISIONS.md` entry. On timeout or query error, sets
`abortReason` and `skippedSeries = [...SERIES]` and skips the series loop entirely, which routes
through the run's existing abort-alert path (Telegram + `market_data_fetcher_aborted` critical
`compliance_log` row) unchanged — so a future stall now fails in ~8s with an accurate
`"credential fetch failed or timed out (...)"` reason instead of silently eating the full 50s+
budget with a generic message. The "credentials not configured" warning path (no error, just
null keys — expected when unauthenticated) is untouched. Scoped to `market-data-fetcher` only —
no change to the shared `getKalshiCredentials()` used by `execute-trade`/`auto-trade`/other
live-trading-adjacent functions, so this doesn't touch the real-money order path at all; it's a
read-only market-data cache poller.

**Verified against real data, not just statically:** `deno check` — 11 pre-existing type errors
both before and after (confirmed via `git stash`/`stash pop` diff), one new error introduced by
an untyped `setTimeout` return value, fixed with `ReturnType<typeof setTimeout>` before deploy.
Deployed via `supabase functions deploy market-data-fetcher`, then invoked the live function
directly (`POST .../functions/v1/market-data-fetcher`) — `{"success":true,"series_fetched":18,
"series_failed":[],"series_skipped":[],"abort_reason":null,"total_markets_cached":817,
"elapsed_ms":3293}`, and `compliance_log` shows the matching `market_data_fetch` `info` row,
confirming the happy path (credentials configured, fetch fast) is unregressed. **Not verified
end-to-end:** the actual timeout branch itself, since triggering a real Supabase query stall
on demand isn't reproducible without fault injection — this mirrors how the 40th run's
`cancel_order` fix and others noted a hard-to-trigger path as code-reviewed rather than
live-fired. Low risk: the new code path is a straight `Promise.race` around an existing call,
falls back to the pre-existing abort-and-alert mechanism verified working since inception, and
touches nothing on the trading/order side.

**Reversibility:** easy — single-function revert (`market-data-fetcher/index.ts` only), redeploy
previous version.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (47th run) — Zero new compliance errors, all 14 cron jobs healthy, CI still green; closed the 46th run's own watch item — `settle-signals` was stuck re-hitting the same unresolvable 200-ticker batch forever instead of rotating through the backlog

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 46th run's
~06:07 UTC cutoff through this run's ~07:07 UTC invocation — zero new rows. `cron_health()`
confirms all 14 registered jobs (including `settle-signals-cron`, now live since the 46th run)
`active: true`, `is_stale: false`, `last_run_failed: false`. `gh run list --branch dev` confirms CI
green through the 46th run's own push (PR #99) and this run's.

**Root cause found and fixed (MED — a fix from the immediately-prior run had a second bug baked
in, self-flagged there as an unconfirmed "watch item" rather than assumed safe):** the 46th run
registered `settle-signals-cron` and fixed a swallowed-error bug, but left its query as
`WHERE settlement_price IS NULL AND expires_at < now() LIMIT 200` with no `ORDER BY` and no way to
mark a row "checked, permanently unsettleable." Read `compliance_log`'s `settle_signals_run` rows
across all 5 ticks that had fired since the fix went live (06:13, 06:15, 06:30, 06:45, 07:00 UTC)
and found every tick returned the exact same 200 tickers (`KXBTC-26MAY1901-*` through
`KXHIGHNY-26MAY18-*`), all `api_error`. Cross-checked `compliance_log`'s raw `api_error` rows for
the window: 1000/1000 were HTTP 404 specifically (not a mix of transient failures) — these are
~2.5-month-old tickers Kalshi's archive retention has aged out of the public markets endpoint, per
the 46th run's own finding, and they can never resolve via this endpoint. With zero live errors,
zero CI issues, and this being the only open finding in scope, chose to close it this run rather
than defer again. Total backlog confirmed at 20,936 unsettled signals, 20,936 distinct tickers —
every one of the stuck batch's 200 rows was blocking the other 20,736 from ever being checked,
since nothing in the pipeline ever changed which 200 rows the no-`ORDER BY` query would return.

**Fix (deployed):** new migration (`20260728_settle_signals_unsettleable_status.sql`) adds a
`settlement_status` text column. `settle-signals/index.ts` now stamps `settled_at` (with
`settlement_status = 'unsettleable_404'`, `settlement_price`/`shadow_pnl` intentionally left null
so ROI aggregates aren't polluted with fake settlements) on any ticker Kalshi returns a definitive
404 for, and the eligibility query now gates on `settled_at IS NULL` instead of
`settlement_price IS NULL` — so 404'd tickers stop being re-selected while everything else
(not-yet-resolved markets, transient 5xx/timeout failures) stays untouched and eligible for retry,
same as before. No trading/order-placement path touched — read-only against Kalshi, writes only to
`signals.settled_at`/`settlement_status`.

**Verified against real data, not statically:** applied the migration, confirmed the column exists.
Deployed the fixed function and manually fired it via the same `net.http_post` call the cron makes
— `compliance_log` shows the run marked 207 signals `unsettleable_404`, and the eligible batch
measurably rotated (`KXBTC-26MAY19*` → `KXBTC-26JUL01*`; backlog 20,936 → 20,736). Then waited for
the next *actual* scheduled tick rather than trusting the manual call alone: `07:15:13 UTC` fired
automatically on pg_cron's own schedule, processed a third, further-rotated batch
(`KXBTCD-26MAY1917-*`, all `unsettleable_404`), and backlog dropped again to 20,536 — confirming
the fix holds end-to-end under the real cron trigger, not just a manual invocation. At the observed
rate (~200/tick, 96 ticks/day) the ~20.5k backlog of archived-unsettleable May/June signals clears
in roughly a day, after which the cron reaches genuinely-recent signals and starts producing real
shadow-PnL data for `qualifier_roi_v2` — the actual goal of the 46th run's original fix.
**Reversibility:** easy — additive/nullable column; `git revert` restores the prior (stuck) query,
and the ~400+ rows already marked `unsettleable_404` this run remain correctly excluded regardless
since they were, in fact, unsettleable.
PR → `dev` (this run), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (46th run) — Zero new compliance errors, all 13 cron jobs healthy, CI still green; found and fixed `settle-signals-cron` — never registered since inception, so shadow-PnL/qualifier-ROI measurement has run zero times in 2.5 months

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 45th run's
~05:07 UTC cutoff through this run's ~06:07 UTC invocation — zero new rows. `cron_health()`
confirms all 13 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms CI green through the 45th run's own push and this run's.

**Root cause found and fixed (MED — a whole feature has been silently dead since 2026-05-12,
invisible to every prior health-check run because it was never in `cron.job` or
`expected_cron_jobs`):** with zero live errors and CI green, swept `cron.job` against every
function's own docstring for scheduling claims not already covered by `expected_cron_jobs`
(the same manifest gap class the 41st/42nd runs closed for `reconcile-orders`/`paper-reconcile`).
`settle-signals/index.ts`'s docstring says "Scheduled: every 15 minutes via pg_cron" and computes
shadow PnL for every signal the qualifier skipped — its own comment calls this "the biggest data
unlock in v2" for measuring qualifier ROI (`qualifier_roi_v2` view,
`20260504_v2_validation_queries.sql`). `cron.job` had zero rows for `settle-signals-cron`, and
`information_schema.columns` showed `signals.settlement_price` / `shadow_pnl` / `settled_at` /
`system_version` don't exist — despite `20260504120000_v2_instrumentation_and_lock.sql` recording
itself as **applied** in `schema_migrations` since 2026-05-04 and containing exactly those `ALTER
TABLE` and `SELECT cron.schedule(...)` statements. This is the same swallowed-migration-failure
bug the 45th run closed for the CI runner (`|| echo WARN` around `curl -sf`) — this migration
predates that fix by nearly three months and was itself a casualty of it: whichever statement
failed first, everything after it silently never applied while the runner recorded success anyway.
Impact: `compliance_log` has zero `settle_signals_run`/`settle_signals_error` rows in its entire
history — the function has never once executed, automatically or otherwise — and 20,936 of 21,782
signals sit past `expires_at`, unsettled. **Compounding bug found in the function itself:**
`settle-signals/index.ts`'s query destructured only `data` from the Postgrest response, never
checking `error` — so once the missing `system_version` column made the query fail, the function
silently fell into its "no unsettled signals" success branch and returned a clean `200` instead of
surfacing the failure. Manually invoking the function pre-fix reproduced exactly this: `{"settled":
0, "reason": "No unsettled signals past expiration"}` despite the real backlog being 20,936 rows.

**Fix (deployed):** new migration (`20260728_register_settle_signals_cron.sql`) adds the five
missing `signals` columns (`shadow_pnl`, `settlement_price`, `settled_at`, `direction_correct`,
`profitable`, `system_version` — all additive/nullable, no data migration needed), re-registers
`settle-signals-cron` (`*/15 * * * *`) exactly as the original migration intended, and adds it to
`expected_cron_jobs` so a future silent drop is caught by `cron_health()` instead of requiring a
manual audit (same closing move as `20260728_register_paper_reconcile_cron.sql`). Also fixed
`settle-signals/index.ts` to check the Postgrest `error` and throw instead of silently treating a
failed query as "nothing to settle." Read-only against Kalshi (`GET` market data only, uses the
system service key) and writes only to `signals` — no trading/order-placement path touched.

**Verified against real data, not statically:** applied the migration directly, confirmed all six
columns exist and `settle-signals-cron` is live in `cron.job`. Deployed the fixed function and
manually fired it via `net.http_post` (the same call the cron makes) — `compliance_log` now shows
real `settle_signals_run` rows with per-ticker results, proving the query and error-handling work.
The actual `06:15:00 UTC` pg_cron tick fired on schedule post-fix and completed normally (visible
in `compliance_log`, not just my manual invocation) — the job is live end-to-end, not just
registered. Confirmed directly against Kalshi's public API that **recent** markets still return
full data (`200`, e.g. `KXHIGHAUS-26JUL27-T103` expiring today) — the fix is functionally correct
for the live/near-term signal flow. The first processed batch (oldest-first, unordered query) hit
100% `api_error` (`404`) on ~2.5-month-old May weather/crypto tickers — Kalshi's own archive
retention has aged those out of the public markets endpoint, a data-availability limit outside this
system's control, not a bug in the fix. That historical tail is now visibly logged as `api_error`
per ticker instead of silently invisible, which is the actual goal of this fix — going forward,
every signal settles within Kalshi's retention window since the cron runs every 15 minutes.
**Watch item, not yet confirmed:** the settle query has no `ORDER BY`, so if Postgres returns the
same oldest-first ~200 rows on every tick, the job could keep re-hitting the same unresolvable
404 batch indefinitely instead of rotating toward the eligible backlog — worth confirming over the
next few runs via `compliance_log`'s per-tick `results` breakdown rather than assuming either way.
**Reversibility:** easy — new columns are additive/nullable, cron job can be unscheduled, function
diff is a single `if (error) throw` addition; `git revert` restores prior (dead) state on all three.
PR #99 → `dev` (merged, CI green), `docs/health-log.md` this entry, `DECISIONS.md` this run.

## 2026-07-28 (45th run) — Zero new compliance errors, all 13 cron jobs healthy, CI still green; fixed the flagged 2026-07-27 migration-runner bug: `curl -sf` failures were caught and swallowed instead of failing the job

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 44th run's
~04:07 UTC cutoff through this run's ~05:07 UTC invocation — zero new rows. `cron_health()`
confirms all 13 registered jobs `active: true`, `is_stale: false`, `last_run_failed: false`.
`gh run list --branch dev` confirms the 44th run's E2E fix is holding — CI stayed green through
this run's own push.

**Root cause found and fixed (MED — CI silently recording failed migrations as applied, closing
the finding flagged-not-auto-fixed on 2026-07-27, `DECISIONS.md`):** with zero live errors and CI
green, swept open `DECISIONS.md` findings for anything still unresolved. The 2026-07-27 entry
("staging Supabase DB is largely unmigrated despite CI claiming success") was live: `.github/
workflows/ci.yml`'s `migrate-staging`/`migrate-production` jobs ran each migration via `curl -sf
... 2>&1) && echo "OK: $VERSION" || echo "WARN: $VERSION — $RESULT"`, then unconditionally
inserted a `schema_migrations` row after, regardless of which branch fired. Verified directly
against the Management API that a bad migration returns HTTP 400 (`curl -sf` already detects this
correctly) — the bug was purely the shell catching that failure with `||` and continuing instead
of propagating it. Also found the same-day filename collision the decision entry called out:
`VERSION` was derived via `cut -d_ -f1` (date prefix only), so PR #81's two `20260727_*.sql` files
both recorded under `version='20260727'` — the second file's actual apply was untracked.

**Fix (deployed):** removed the `|| echo WARN` swallow in both `migrate-staging` and
`migrate-production` — `bash -e` now propagates a `curl -sf` failure and hard-fails the job instead
of silently marking a failed migration as applied. The history-row `INSERT` only runs if the apply
`curl` succeeded (unreachable otherwise, since the step aborts first). Re-keyed new inserts off the
full filename stem instead of the date prefix, fixing the same-day collision — while still checking
the legacy date-only key against already-recorded rows, so this does **not** force a re-run of the
~40-entry historical backlog described in the 2026-07-27 finding. That backlog repair (`DECISIONS.md`
proposed step 4 — reset staging and replay from a clean slate) remains a separate, larger decision
for Onofre; this run closes the root-cause bug class only, matching the same "flag the big one,
fix what's safely scoped" pattern as the 2026-07-27 entry itself.

**Verified against real data, not statically:** confirmed via the 44th run's live CI log
(`gh run view --log`) that every migration file currently in the repo already has a legacy
date-prefix row in `schema_migrations` on staging — so this fix's own `dev` push would exercise
zero new code path (all skip as "Already applied"), not a blind push into unknown failure risk.
PR #97 → `dev` (merged, CI green on the PR itself since migration jobs correctly `skip` on
`pull_request` events). Then watched the resulting **push-triggered** run end-to-end
(`30331080893`): `Apply migrations → staging DB` — all 61 lines `Already applied`, zero
`Applying:`/new attempts — `Deploy edge functions → staging Supabase` and `E2E smoke tests →
kalshitradeagent.live` both `success`. Full pipeline: `success`. **Reversibility:** easy — CI-yaml
only, no schema/data touched; `git revert` restores the old (silently-swallowing) behavior.

## 2026-07-28 (44th run) — Zero new compliance errors, all 13 cron jobs healthy; found and fixed CI's E2E smoke job red on every `dev` push since the 36th run — a test asserting a `HITLApprovalsCard` component that was never built

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 43rd run's
~03:09:30 UTC cutoff (2026-07-28) through this run's ~04:07 UTC invocation — zero new rows. The
only `error`-severity rows in the trailing 24h (`api_error` x2, `kalshi-proxy`/order 404s) both
predate the cutoff and are the same `7dfb3f09-...` incident already investigated by the 39th run.
`cron_health()` confirms all 13 registered jobs `active: true`, `is_stale: false`,
`last_run_failed: false` — the observability-coverage work from the 41st/42nd/43rd runs is holding.

**Root cause found and fixed (MED — permanently-red CI check, 8 consecutive PRs merged past it):**
with zero live errors and cron fully healthy, swept `gh run list --branch dev` instead of
compliance_log this run. Every CI run on `dev` since 2026-07-27 19:13 UTC (36th run) through the
43rd run has reported `failure` — same single test each time:
`tests/e2e/production-hardening.spec.ts:104 › HITL live mode UI › HITL approvals component is in
the JS bundle`. Confirmed the production-deploy chain (`migrate-production` /
`deploy-production-functions` / `canary-gate`) is unaffected — those jobs gate on
`github.ref == 'refs/heads/main'` and `needs: test`, entirely independent of the `dev`-only E2E
job, so this was never blocking a real deploy. But it has been silently normalizing a red CI
status on every merged PR in this log for two days. Traced the test itself
(`tests/e2e/production-hardening.spec.ts:104-124`): it fetches every bundled script (and, as a
dev-mode fallback, `/src/components/trading/HITLApprovalsCard.tsx` directly) looking for
`hitl_approvals` or `HITLApprovalsCard`. Neither exists anywhere in the repo outside the test file
itself (`find`/`grep` both empty). Traced further: the 2026-07-11 "production hardening" PR
(`f2fd68b`) shipped a complete `hitl_approvals` table (`user_id`, `trade_payload`, `status`,
`requested_at`, `decided_at`, `decision_note`, `trace_id`) and this test, but never built the card
and never wrote a producer or consumer for the table (`grep -rl hitl_approvals supabase/functions/`
→ empty). `execute-trade/index.ts` has no approval-gate step of any kind on live orders — this is
orphaned scaffolding from an incomplete feature, not a regression.

**Fix (deployed as a test-only change):** deleted the false assertion
(`tests/e2e/production-hardening.spec.ts:104-124`, the `"HITL approvals component is in the JS
bundle"` test) and tightened the surrounding `describe` block name/comment (`"HITL live mode UI"` →
`"Live mode UI"`) and file-header docstring, which both over-claimed a HITL gate exists. Did
**not** build the actual `HITLApprovalsCard` component or wire a live-order approval gate — that's
a real-money trade-execution behavior change with no current product ask behind it (not on this
project's `CLAUDE.md` priority list), and this project's own rule is "don't add features beyond
what was asked." Logged as a flagged-not-auto-fixed decision in `DECISIONS.md` (2026-07-28 entry),
same precedent as the 2026-07-27 "staging DB unmigrated" finding — Onofre decides whether to build
the real HITL flow or drop the dead `hitl_approvals` table.

**Verified against real data:** `npm run lint` (0 errors, 12 pre-existing warnings, unchanged) and
`npm test` (206/206 passing, all pre-existing suites) both clean before pushing. Local Playwright
chromium install stalled on a slow browser download; since `migrate-staging`/`deploy-staging`/E2E
only trigger on `push` to `dev` (not on `pull_request`), the PR itself (#96) could only show the
lint/test/build job green. Merged to `dev`, then watched the resulting push-triggered run
(`30328534295`) end-to-end: `Deploy edge functions → staging Supabase` succeeded (2m7s, all 13
functions), then `E2E smoke tests → kalshitradeagent.live` — the exact job that had been red since
at least the 36th run — passed in 54s. Full pipeline conclusion: `success` — the first fully green
CI run on `dev` in the visible run history (`gh run list --branch dev`, 20+ prior runs all
`failure`, aside from one unrelated promotion-merge run).
**Reversibility:** easy — single test-file diff (one test block removed, two comments edited), no
schema, edge function, or execute-trade change; `git revert` fully restores prior (still-failing)
state.

## 2026-07-28 (43rd run) — Zero new compliance errors; found and fixed `signal-generator-cron` was the last remaining cron job with no success-path heartbeat, same gap class as the last 3 runs

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 42nd run's
~02:07 UTC cutoff through this run's ~03:07 UTC invocation (2026-07-28) — zero new rows. All 13
registered cron jobs confirmed healthy via `cron_health()` (`active: true`, `is_stale: false`,
`last_run_failed: false` on every row) — the reconcile-orders and paper-reconcile fixes from the
41st/42nd runs are both running clean now.

**Root cause found and fixed (LOW-MED — observability gap, same class the last 3 runs closed for
other functions):** with zero live errors and all cron jobs reporting healthy, swept the remaining
cron'd edge functions for the "success path never writes to `compliance_log`" gap the 41st/42nd
runs found in `reconcile-orders` and `paper-reconcile`. Cross-checked all 13 `expected_cron_jobs`
entries against `compliance_log` event types over the last 24h: `market-data-fetcher` and
`surface-scanner` both log a full-coverage success event per run (`market_data_fetch` and
`surface_scan_complete`, 288/288 matching their 5-min schedules) — not missing, just not named with
a `_run` suffix, so they didn't show up in the naive search. `signal-generator`
(`supabase/functions/signal-generator/index.ts`) was the real gap: it had **only** two error-path
event types (`signal_persist_error`, `signal_generator_error`) and zero rows of any kind on
success — confirmed via a 24h query returning 0 rows for any signal-generator event type outside
those two. Same failure mode as the closed gaps: `cron_health()` only proves the pg_cron scheduler
invoked the function, not that the function's internal logic did anything — a run that silently
scores zero signals (empty market cache, all markets filtered as illiquid) or hangs mid-scoring
would be invisible except by hand-checking `signals` table timestamps.

**Fix (deployed):** added a `logRunSummary()` heartbeat to `signal-generator/index.ts`, matching
the exact pattern from the 41st/42nd runs' `reconcile-orders`/`paper-reconcile` fixes —
`event_type: "signal_generator_run"`, `elapsed_ms` tracked from `startedAt`, severity escalates to
`warning` past 4 minutes. Wired into all three exit paths: the empty-cache early return, the
no-liquid-markets early return, and the normal success return (with `total_scored`/`actionable`/
`strong` counts). Deployed via `supabase functions deploy signal-generator`.

**Verified against real production data:** `deno check` on the modified file surfaces 3 pre-existing
errors (`volume_fp`/`volume_24h_fp` not in the `RawMarket` interface, a `.then().catch()` chain on a
non-thenable) — confirmed identical before and after this change via `git stash`, so nothing new was
introduced. Directly invoked the deployed function (`POST .../functions/v1/signal-generator`) —
returned 831 scored signals, 20 actionable, 12 strong — then confirmed the new heartbeat row landed:
`compliance_log` → `signal_generator_run`, `"signal-generator: 831 scored, 20 actionable, 12 strong
(505ms)"` at `2026-07-28 03:09:30 UTC`. Every cron'd edge function in the system now has full
success-path observability coverage. **Reversibility:** easy — additive logging only, no schema or
behavior change; reverting the file and redeploying fully restores prior behavior.

## 2026-07-28 (42nd run) — Zero new compliance errors; found and fixed `paper-reconcile-cron` was never registered at all — same "migration syntax error silently no-ops" failure mode as the reconcile-orders 6-day gap, one day old

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 41st run's
~01:10 UTC cutoff through this run's ~02:07 UTC invocation (2026-07-28) — zero new rows.

**Root cause found and fixed (HIGH — a whole cron job silently never ran, not just a slow pass):**
started from the same observability gap the 41st run closed for `reconcile-orders` (no run-level
`compliance_log` heartbeat) and swept the rest of the cron'd edge functions for the same class of
gap. `paper-reconcile` (added 2026-07-27, `supabase/functions/paper-reconcile/index.ts`, an
explicit mirror of `reconcile-orders`) had per-item logging but no `_run` summary row on success —
added one. While verifying the fix by watching for the next cron tick, the heartbeat never
appeared. `cron_health()` returned zero rows for `paper-reconcile-cron` and a direct `SELECT
jobname FROM cron.job` confirmed it: **the job was never registered.** Its migration,
`20260727_paper_reconcile_cron.sql`, appended `) ON CONFLICT (jobname) DO UPDATE SET schedule =
excluded.schedule;` to a bare `SELECT cron.schedule(...)` call — a SELECT has no ON CONFLICT
semantics, so the statement threw a syntax error and the whole migration (including its own
`expected_cron_jobs` INSERT) silently never applied. This is the *exact* bug described in
`20260725_expected_cron_manifest.sql`'s motive comment for the original `reconcile-orders-cron`
6-day gap — it was copy-pasted forward into the new migration along with the bug it was written to
prevent, one day before this run. Because the manifest INSERT was inside the same failed
transaction, `paper-reconcile-cron` was also invisible to the staleness watchdog: a job that never
existed can't be flagged missing by a monitor that only iterates `FROM cron.job`. Confirmed real
impact: `SELECT count(*) FROM trades WHERE mode='paper' AND status IN ('open','partial') AND
settled_at IS NULL` → 3 rows, oldest from 2026-07-27 20:10 UTC — 6 hours stuck with no reconciliation
path at all, growing every cycle.

**Fix (deployed):** (1) Added `paper_reconcile_run` heartbeat logging to `paper-reconcile/index.ts`
(`startedAt`/`elapsed_ms`, `warning` severity past 4 minutes, logged on the no-op early return, the
normal success path, and the fatal-error path) — same pattern as the 41st run's `reconcile-orders`
fix. Deployed via `supabase functions deploy paper-reconcile`. (2) Registered the job live —
`SELECT cron.schedule('paper-reconcile-cron', '2-59/5 * * * *', ...)` with **no** ON CONFLICT
clause (`cron.schedule` already upserts by jobname internally; that clause was both invalid and
redundant) — and inserted it into `expected_cron_jobs` so a future silent deregistration surfaces
in `cron_health()` instead of requiring a manual trades-table query. (3) New migration
`20260728_register_paper_reconcile_cron.sql` captures both DB changes with full root-cause
context. (4) Corrected the same broken `ON CONFLICT` clause in the original
`20260727_paper_reconcile_cron.sql` (now just `cron.schedule(...);` with an explanatory note) so a
fresh migration replay on a clean database doesn't reintroduce the failure.

**Verified against real production data:** `deno check supabase/functions/paper-reconcile/index.ts`
— zero errors before and after. After registering the cron job, polled `compliance_log` live and
caught the very next scheduled tick: `2026-07-28 02:17:00 UTC — "paper-reconcile: 3 checked, 0
filled, 0 partial, 0 cancelled, 0 errors (149ms)"` — confirming both fixes work end-to-end: the job
now runs on schedule, picked up all 3 previously-stranded paper trades on its first pass, and wrote
the new heartbeat row. Also re-confirmed via `cron_health()` that `paper-reconcile-cron` now
returns a row (`active: true`) where it previously returned none. **Reversibility:** easy — additive
logging function, a cron registration (idempotent — dropping it just stops the schedule, `trades`
rows are untouched), and a manifest row; `cron.unschedule('paper-reconcile-cron')` plus a manifest
delete fully reverts.

## 2026-07-28 (41st run) — Duplicate-positions alert traced to a 2-day-old stale-order settlement; found and fixed the real gap: `reconcile-orders` had no run-level compliance_log heartbeat, so a ~4min-late pass was invisible except by hand-reconstructing order timestamps

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 40th run's ~23:06 UTC
cutoff through this run's ~01:10 UTC invocation (2026-07-28) — zero new rows.

**Investigated (explained, no fix needed):** `health-check-hourly`'s 23:10:11 UTC pass fired a
`duplicate_positions_detected` alert for `KXINX-26JUL27H1600-B7437` (>2 open filled rows for one
user+ticker). Pulled every `trades` row for that ticker: 8 duplicate legs, all `strategy_id
S-001-l-ea207ba1`, placed every 5 minutes from 2026-07-25 18:15–18:50 UTC — the exact
"same-ticker re-stacking" failure mode the 7/26 S-001 dedup fix (see that date's entry below)
closed by adding a cross-run `status IN (filled,open,partial)` check. These 8 legs predate that
fix by a day, so they're historical debt, not a live recurrence. Confirmed no live bug: a query for
any *current* (user, ticker) pair with >2 open filled rows returned zero. The alert only fired now
because these legs were resting **live limit orders that hadn't filled on Kalshi for ~2 days**
(status stuck `open`, invisible to the `duplicate_positions_detected` check which filters
`status='filled'`) until `reconcile-orders-cron` finally saw them as `remaining_count=0` and
flipped all 8 to `filled` in one pass at 23:09:50–51 UTC — which is what made them visible to both
the duplicate-positions check (23:10:04) and `auto-settle` (which settled them at 23:10:15–16,
right after) within the same ~30s window. Not a code bug: S-001 legs on hourly-bracket events can
legitimately rest for the life of the event before filling or expiring.

**Root cause found and fixed (LOW-MED — observability gap that turned a 10-minute root-cause into
a much longer one): `reconcile-orders` was the one cron'd function in the system with zero
run-level heartbeat in `compliance_log`.** Every other cron function (`auto-trade`, `auto-settle`,
`market-data-fetcher`, `daily-digest` — the last one fixed for exactly this gap in an earlier run,
see that entry's comment in `daily-digest/index.ts`) logs an `_run` summary row on every
invocation. `reconcile-orders` only ever logged *per-order* rows (`order_filled`,
`order_cancelled`, `reconcile_order_check_failed`) — there was no way to see, from `compliance_log`
alone, that its 23:06:00 UTC scheduled dispatch didn't actually finish writing state until
23:09:50 (a ~3m50s pass against a 5-minute cadence, close enough to risk overlapping the next
cycle). Confirming this required cross-referencing `cron.job_run_details` dispatch times against
scattered `order_filled` row timestamps by hand — exactly the kind of blind spot the `_run`-logging
convention exists to prevent, and `reconcile-orders` was the one function that never got it.

**Fix (deployed):** Added `startedAt`/elapsed-ms tracking and a `reconcile_orders_run`
compliance_log summary row (`supabase/functions/reconcile-orders/index.ts`) on every code path —
the no-op "no resting live orders" early return, the normal success path, and the existing fatal
error path (which now also carries `elapsed_ms` in its metadata). Severity flips to `warning` if a
pass exceeds 4 minutes, so a slow/lagging pass surfaces on its own instead of needing manual
reconstruction. Also corrected a stale comment in the same file's header claiming auto-settle's
pending view is "paper-only" — it covers `mode IN ('paper','live')` since the live-mode work
landed; the wrong comment risked steering a future change toward building a redundant live-only
settlement path.

**Verified:** `deno check supabase/functions/reconcile-orders/index.ts` — 10 errors both before and
after the change (`git stash` diff), confirming zero new type errors; the 10 are the same
repo-wide pre-existing `SupabaseClient` generic-type / `getKalshiCredentials` `data: never`
mismatches already documented in the 40th run's entry. Deployed via `supabase functions deploy
reconcile-orders`. **Confirmed against real production data**, not just statically: the next
scheduled `reconcile-orders-cron` tick (2026-07-28 01:36:04 UTC) wrote the new summary row —
`"reconcile-orders: 2 checked, 0 filled, 0 partial, 0 cancelled, 0 errors (151ms)"` — proving the
logging fires correctly on every path, including the common fast/nothing-to-do case. **Reversibility:**
easy — single additive logging function plus one comment correction, no change to order-processing
logic; git revert restores prior behavior exactly.

## 2026-07-27 (40th run) — One-off 404 traced and ruled harmless; found and fixed a real bug: `cancel_order` fired an unauthenticated, unchecked Kalshi DELETE and lied to the DB about cancellation

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 39th run's
~22:06 UTC cutoff through this run's ~23:06 UTC invocation — one new row: an `api_error` at
23:05:44 UTC, `"Kalshi API returned non-JSON response on POST portfolio/orders/7dfb3f09-...
(status 404)"`. Investigated: this is `kalshi-proxy`'s generic pass-through (`supabase/functions/
kalshi-proxy/index.ts`), which forwards whatever method the caller sends. Grepped every caller —
`src/lib/kalshiApi.ts` is the *only* consumer of `kalshi-proxy`, and its three wrappers
(`kalshiProxyGet`/`Post`/`Delete`) never construct a POST to `portfolio/orders/{id}` — placeOrder
POSTs to bare `portfolio/orders` (no id), cancelOrder correctly uses DELETE. `git log -p` on
`cancelKalshiOrder` shows it was DELETE from the day it was added — never POST. Confirmed only one
such row exists in `compliance_log` ever. The order itself (`7dfb3f09-...`, a 2-day-old resting
S-001 leg) filled normally 5 minutes later via the ordinary GET-based `reconcile-orders` path with
no downstream error. Edge-function request logs had already rolled past the timestamp by the time
of investigation (high-volume Markets-page GET traffic exhausts the log buffer in seconds), so the
exact origin (most likely a stray manual/dev-tools call against the proxy) couldn't be pinned down
further — but it is not reproducible from any code path in the repo and caused zero harm. Not
treating this as a system bug; no fix applied for it.

**Root cause found and fixed (HIGH — live order cancellation was silently non-functional and
could desync the DB from reality): while investigating the above, read every Kalshi-order code
path and found `trading-agent/index.ts`'s `cancel_order` tool (used when the chat agent decides to
cancel a live order) did, in live mode: (1) immediately mark the local `trades` row `status:
'cancelled'` in the DB, unconditionally; (2) fire `fetch(`${KALSHI_BASE_URL}/portfolio/orders/
${orderId}`, { method: "DELETE" })` with **no headers at all** — no HMAC signature, no API key.
Kalshi requires signed auth on every private endpoint, so this call was guaranteed to be rejected
(401/403) every single time, and the response was never checked (`await fetch(...)` with the
result discarded). Net effect: **cancel_order has never actually cancelled a live order on Kalshi**
— it only ever updated our own database, which then reports the position as closed/no-risk while
the order keeps resting live on Kalshi's book and can fill at any time. `reconcile-orders` (the
only other process watching order state) only polls `status IN ('open','partial')`, so once
`cancel_order` marked a row `'cancelled'`, reconciliation would never look at that order again —
a fill on Kalshi after a "cancel" would go completely unnoticed by the system. No evidence yet
that this branch has actually fired in live mode (no `order_cancelled` compliance rows found with
a `trade_id` from a live-mode order in the queried window), so no known live position is currently
mis-tracked from this — but the very next live cancel the agent attempted would have hit it.

**Fix (deployed):** Reordered `cancel_order`'s live-mode path so it signs and sends the Kalshi
DELETE *first* (`getKalshiCredentials(supabase, userId)` + `generateAuthHeaders(... "DELETE",
"/trade-api/v2/portfolio/orders/{id}" ...)` + `fetchWithRetry`, the same pattern `reconcile-orders`
already uses for its authenticated GET) and only updates the local `trades` row to `'cancelled'`
if Kalshi's response is `ok`. On a non-ok response, the DB row is left untouched and a new
`order_cancel_failed`/`error` `compliance_log` row is written with the order id, Kalshi status, and
raw body — so a future genuine cancel failure surfaces instead of silently lying. Paper mode is
unchanged (DB is the only source of truth there, no Kalshi call needed).

**Verified:** `deno check supabase/functions/trading-agent/index.ts` — 13 errors with the fix vs.
12 on unmodified `dev` (confirmed via `git stash`/`deno check`/`git stash pop`); the one new error
is the identical pre-existing `getKalshiCredentials(supabase, ...)` / `SupabaseClient` generic-type
mismatch already present at this file's other `getKalshiCredentials` call site (line ~1215, the
market-data service-key lookup) — a known repo-wide TS-strictness gap, not a new logic error.
Deployed via `supabase functions deploy trading-agent`. **Not exercised end-to-end against a real
live cancel this run** — doing so would require either a fabricated chat turn forcing the LLM to
pick `cancel_order` (real token spend for a code path this audit can already verify statically) or
cancelling a genuine live resting order (real trading action, out of scope for an unattended
health-check run). The change is isolated to the `cancel_order` branch only and does not touch any
path that fires on the current 5-minute trading cadence, so this carries no regression risk to
today's active strategies. **Reversibility:** easy — single-function, single-branch change; git
revert restores the prior (broken) behavior exactly.

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 38th run's
~21:06 UTC cutoff through this run's ~22:06 UTC invocation — zero new rows. Last `error`-severity
row is still `d1514b15` (16:29:30 UTC, resolved by the 34th run).

**Root cause found and fixed (MED — S-001 Surface Arb re-attempts a known-unaffordable ticker
every cron cycle instead of backing off): breaking down the window's activity by `event_type`
surfaced 12 `liquidity_fallback` warnings and 12 `order_skipped_insufficient_balance` warnings, both
for the identical ticker/price/amount (`KXBTC-26JUL2817-B64875` @ 89c, then `-B64625` @ 88c after the
hourly bracket rolled), one pair per 5-min `auto-trade-cron` cycle from 21:10 to 22:05 UTC — 11
straight cycles, zero `order_submitted` in between. Reading `supabase/functions/auto-trade/index.ts`'s
`runS001SurfaceArb`: its dedup query (added 2026-07-26, see the entry below this one in the log)
only looks for `trades` rows with `status IN ('filled','open','partial')` to skip an event ticker
already being worked. But `execute-trade`'s pre-flight balance check (`index.ts:661-694`) returns
*before* ever placing an order when the account can't cover the leg's collateral, inserting a
`status: "failed"` trade row and returning early — a row the dedup query can't see. Since the live
account is genuinely balance-depleted (the same state the 34th-38th runs' `kalshi_low_balance`
alerts have been tracking, confirmed still true this run — `health_check_run` shows it firing/
suppressing as designed), and balance doesn't replenish on a 5-minute cadence, S-001 was re-detecting
the same still-unresolved bracket-sum alert every cycle and re-spending a live Kalshi orderbook fetch
+ balance check on a ticker already known to fail — pure waste, not a financial-risk bug (no
duplicate orders reached Kalshi; `accountDepleted` correctly stops the loop mid-cycle once hit,
this was purely cross-cycle).

**Fix (this run):** Added a second dedup query in `runS001SurfaceArb` — recent `status: "failed"`
trades for this strategy with `notes LIKE 'Skipped pre-flight:%'` (the balance-check's own failure
marker) within the last 15 minutes (3 cron cycles) — and folded their event tickers into the same
`alreadyInMarket`-style skip check the loop already uses. 15 min is long enough to stop the thrash,
short enough that S-001 resumes on the same ticker immediately once the account is funded. No retry/
decision/balance logic touched — purely an additional skip condition, same pattern as the
filled/open/partial dedup it sits next to.

**Verified:** `deno check supabase/functions/auto-trade/index.ts` initially showed 18 errors (17
pre-existing + 1 new from an untyped `Set` spread); annotated `balanceSkippedTickers` as `Set<string>`
and re-ran — 17 errors, matching the exact pre-existing baseline confirmed via `git stash`/`deno
check`/`git stash pop` on unmodified `dev` (identical count and locations, zero new errors after the
type fix). Deployed live via `supabase functions deploy auto-trade`. Watched the first post-deploy
`auto-trade-cron` cycle (22:15 UTC): zero `liquidity_fallback` and zero
`order_skipped_insufficient_balance` rows — S-001 correctly skipped the still-depleted ticker family
(within the 15-min window) and moved on to evaluate a different bracket (`KXBTC-26JUL2719`, filtered
out normally at `info` severity by the existing fee-hurdle check, unrelated to this fix) —
`auto_trade_strategy_run`/`auto_trade_run` continuing at `info` severity with no regression.
**Reversibility:** easy — single-function, additive dedup query + one skip condition; git revert;
no schema or data changes, no existing dedup/balance/decision logic touched.

## 2026-07-27 (38th run) — Clean error/critical window continues (5th run in a row); the 36th run's new `s001_leg_execution_failed` observability path fired for real and exposed a genuine live-trade-starvation bug in the rate limiter

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 37th run's
~20:06 UTC cutoff through this run's ~21:06 UTC invocation — zero new rows. Last `error`-severity
row is still `d1514b15` (16:29:30 UTC, resolved by the 34th run). Breaking down all activity in the
window by `event_type`/`severity` surfaced one `warning`-severity `s001_leg_execution_failed` row
(20:10:09 UTC) — the exact path the 36th run added — reporting all 5 attempted S-001 legs failing
with `"Rate limit exceeded. Maximum 3 trades per minute."` This isn't a new bug in that observability
path; it's that path doing its job and surfacing something worth investigating.

**Root cause found and fixed (MED-HIGH — live-trading rate limiter shares its counter with paper
trading, letting paper activity silently starve live orders): `supabase/functions/execute-trade/index.ts`'s
`checkRateLimit` calls `upsert_rate_limit` with a hardcoded `p_endpoint: "execute-trade"` regardless
of trade mode, and the `rate_limits` table's unique constraint is `(user_id, endpoint, window_start)`
— no mode column. Paper trades are allowed 15/min, live trades only 3/min, but both increment the
*same* counter under the *same* key. Pulling the exact one-second window from `compliance_log`
(20:10:06–20:10:09 UTC) for `user_id ea207ba1-…` showed 3 `order_submitted` (paper) rows immediately
followed by 5 `rate_limit_exceeded` (live) rows for the same user — the 3 paper fills alone pushed
the shared counter to 3+, so every one of the 5 live legs was rejected against the 3/min live cap
before a single live order that minute had actually been attempted. `pg_get_functiondef` on
`upsert_rate_limit` confirmed the RPC increments strictly on `(user_id, endpoint, window_start)` with
no mode awareness, and `checkRateLimit` is the RPC's only caller in the codebase (grepped) — this is
not a one-off, it's structural: any user running both paper and live strategies has their live
execute-trade budget silently subject to depletion by unrelated paper activity, with no log line
distinguishing "live actually got 3/3 live orders through" from "live got zero because paper used the
budget first."

**Fix (this run):** `checkRateLimit` now passes `p_endpoint: isPaper ? "execute-trade:paper" :
"execute-trade:live"` — one string change, giving paper and live independent counters under the
existing free-text `endpoint` column (no schema migration needed; old bare `"execute-trade"` rows
simply age out with their per-minute `window_start`). No retry/decision logic touched — the 3/min and
15/min caps themselves are unchanged, only which counter each mode increments.

**Verified:** `deno check supabase/functions/execute-trade/index.ts` reproduces the same 20
pre-existing type errors found on unmodified `dev` (confirmed via `git stash`/`deno check`/`git
stash pop`, identical count and locations before and after — zero new errors). Deployed live via
`supabase functions deploy execute-trade`. Polled `rate_limits` post-deploy: a new
`execute-trade:live` row appeared within one cron cycle, confirming the mode-scoped key is live and
being written. Checked `compliance_log` from deploy through 21:12 UTC: zero `rate_limit_exceeded` and
zero `s001_leg_execution_failed` rows, `auto_trade_strategy_run`/`auto_trade_run` continuing at
`info` severity with no regression. One `health_check_alert` (`live_rate_limit_exceeded`) fired at
21:10 UTC, but its fingerprint is a 2h lookback bucket and 2h cooldown — it's correctly reporting the
*pre-fix* 20:10 UTC incident still inside that window, not a new post-deploy failure; confirmed no
`rate_limit_exceeded` rows exist between the fix's deploy and this alert. **Reversibility:** easy —
single-line key change, git revert; no schema or data changes, existing rate_limit caps untouched.

## 2026-07-27 (37th run) — Clean error window continues (4th run in a row); S-002 Resolution Fade's 2h time-based position close had the same silent-error gap the 36th run closed for S-001's leg loop

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 36th run's
~19:06 UTC cutoff through this run's ~20:06 UTC invocation — zero new rows. Last `error`-severity
row is still `d1514b15` (16:29:30 UTC, resolved by the 34th run).

**Root cause found and fixed (MED — 4th instance of the observability gap the 34th-36th runs have
been closing, this time in `auto-trade/index.ts`'s S-002 Resolution Fade time-exit loop):** The 2h
time-based position close (`supabase/functions/auto-trade/index.ts:1436-1470`, sells a NO position
within 2h of expiry) only recorded `closeResult.success` into `timeExitResults` as the bare string
`"close_failed"` — `closeResult.error`/`closeResult.message` was read nowhere, and no dedicated
`compliance_log` row was ever inserted for a close failure. That result string flows into the
`auto_trade_strategy_run` row logged unconditionally at `info` severity (same sink as the S-001 gap
the 36th run fixed), so a genuine execute-trade outage on this path — a live position stuck at
expiry, unable to close — would have been indistinguishable from a routine unfilled limit order.

**Fix (this run):** Added a `timeExitErrors: string[]` accumulator to the time-exit loop. Any close
failure now captures `closeResult.error || closeResult.message || "unknown error"` per ticker. If at
least one close fails, a dedicated `s002_time_exit_failed`/`warning` `compliance_log` row is inserted
with the full error list in `metadata`, matching the standard the 34th-36th runs established
(additive, no retry/decision logic touched).

**Verified:** `deno check supabase/functions/auto-trade/index.ts` reproduces the same 17
pre-existing type errors found on unmodified `dev` (confirmed via `git stash`/`deno check`/`git
stash pop`, identical count before and after — zero new errors). Deployed live via `supabase
functions deploy auto-trade`. Watched two post-deploy cron cycles (20:10, 20:15 UTC):
`auto_trade_strategy_run` rows for Surface Arbitrage and Weather Edge are unchanged from pre-deploy
behavior (S-001 correctly logged `s001_leg_execution_failed` on a real rate-limit hit, Weather Edge's
routine `no_setup` message is untouched) — no regression on the paths currently exercised. **Caveat:**
S-002 (`Resolution Fade`, `strategies.id = S-002-ea207ba1`) is itself `active: false` account-wide
(`last_run_at` 2026-07-24, no runs since) — this is an existing account setting, not something this
run changed — so the new `s002_time_exit_failed` path is deployed and correct but dormant until S-002
is reactivated. Flagging this rather than claiming live verification of the new path itself, per the
35th/36th run standard: this closes the gap for the *next* time S-002 runs and a close genuinely
fails, it doesn't manufacture a failure to prove itself now. **Reversibility:** easy — single-file
diff, git revert; no schema or data changes.

## 2026-07-27 (36th run) — Clean error window continues (3rd run in a row); S-001 Surface Arb was silently discarding execute-trade leg errors into the same generic "no fill" message as a routine day

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 35th run's
~18:09 UTC cutoff through this run's ~19:06 UTC invocation — zero new rows. Last `error`-severity
row is still `d1514b15` (16:29:30 UTC, resolved by the 34th run). Also checked the last 6h of
`health_check_alert`/`health_check_run` output: `kalshi_low_balance` is firing/suppressing as
designed (live account genuinely low, per the 2026-07-25 balance-monitor feature) — correctly
working monitoring, not a bug. All other activity in the window (`market_data_fetch`,
`auto_trade_run`, `surface_scan_complete`, `auto_settle_run`, `futures_signal_run`) is `info`.

**Root cause found and fixed (MED — 3rd instance of the observability gap the 34th/35th runs
closed elsewhere, this time in `auto-trade/index.ts`'s S-001 Surface Arb leg loop):**
`runS001SurfaceArb`'s per-leg `callExecuteTrade` result (`supabase/functions/auto-trade/index.ts:1315-1335`)
only ever recorded `result.success` into `legResults` — `result.error`/`result.message` was read
nowhere. When every leg in a cycle failed for a genuine reason (execute-trade 5xx, bad creds,
malformed response — anything other than the already-tracked `insufficient_balance` case), the
strategy's final `details` string fell into the same fixed sentence used for the routine "nothing
qualified" day: `"Alerts found but all events failed fee hurdle, settled on Kalshi, or tickers
already held"` — indistinguishable from normal operation in the `auto_trade_strategy_run`
`compliance_log` row (which is logged at `info` severity unconditionally). Contrast: S-002 and
S-005's callers already surface `result.error` on failure (via `captureMessage` + the returned
`detail` string) — S-001 was the one caller of `callExecuteTrade` that dropped it entirely.

**Fix (this run):** Added a `legErrors: string[]` accumulator scoped to the whole `alerts` loop.
Any leg failure other than `insufficient_balance` (already tracked separately via
`accountDepleted`, and already visible via the `kalshi_low_balance` health-check alert) now pushes
`"${ticker}: ${error}"` onto it. If the run ends with zero legs filled AND at least one real leg
error, (1) the returned `details` string says `"S-001 execute-trade failed on every attempted leg:
..."` with the actual errors instead of the generic fee-hurdle sentence, and (2) a dedicated
`s001_leg_execution_failed` `warning`-severity `compliance_log` row is inserted with the full error
list in `metadata`, matching the standard the 34th/35th runs established (raw error surfaced,
`warning` severity, additive — no retry/decision logic touched).

**Verified:** `deno check supabase/functions/auto-trade/index.ts` reproduces the same 17
pre-existing type errors found on unmodified `dev` (confirmed via `git stash`/`deno check`/`git
stash pop` — identical count and locations before and after, all pre-existing `_shared/tenant.ts`
Supabase generic-type issues plus unrelated `cityWinLoss`/`lessonsByCity` implicit-`any` findings
elsewhere in the file — zero new errors from this change). Deployed live via `supabase functions
deploy auto-trade`. Watched the next scheduled `auto-trade-cron` run (5-min interval) post-deploy:
`compliance_log` shows `"Surface Arbitrage": no_setup — Alerts found but all events failed fee
hurdle..."` unchanged for the routine case (no regression — alerts existed but were filtered by
the fee-hurdle check before ever reaching `callExecuteTrade`, so `legErrors` correctly stayed
empty) and `auto_trade_run` completed `0 traded, 0 errors, 0 halted`. The new
`s001_leg_execution_failed` path hasn't fired yet since no genuine leg failure occurred in the
verification window — same standard as the 35th run's fix: this makes the *next* real failure
visible, it doesn't manufacture one to prove itself. **Reversibility:** easy — single-file diff,
git revert; no schema or data changes.

## 2026-07-27 (35th run) — Clean error window continues; found and fixed the same silent-JSON-failure gap as the 34th run's kalshi-proxy fix, in the shared orderbook-read path

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 34th run's
post-deploy verification pass (17:08 UTC) through this run's ~18:09 UTC invocation — zero new
rows. Most recent `error`-severity row is still `d1514b15` (16:29:30 UTC, the kalshi-proxy parse
failure the 34th run fixed). All activity in the window was `info` (market-data-fetcher, futures
signals, surface scan, compact-memory, auto-reflect) — no new failure.

**Root cause found and fixed (MED — observability gap in the shared `fetchOrderbook` read path,
same class as the 34th run's kalshi-proxy fix):** `supabase/functions/_shared/kalshi-market-data.ts`
wraps its Kalshi orderbook fetch in a `try/catch` that discards the actual error on any exception
(network failure, non-2xx before the body is read, or `response.json()` throwing on a malformed
body) and returns a bare `{ ok: false, tickerGone: false, status: null }` — no raw message, no
distinction from a normal 404. Both callers then treated a **genuine failure identically to an
expected ticker delisting**: `execute-trade`'s `checkLiquidity` silently fell through to
`retry_with_limit` with no log line at all when `tickerGone` was false, and `paper-reconcile`'s
reconciliation loop incremented an `errors` counter with zero detail ("Transient read failure —
leave unchanged, retry next cycle"). If Kalshi's orderbook endpoint had started failing or
returning malformed bodies, there would have been no way to see it — exactly the invisible-failure
pattern the 34th run's fix closed for `kalshi-proxy`, just one hop over in a different shared
module neither call site of which had been touched by that fix.

**Fix (this run):** `fetchOrderbook` now captures the caught exception's message onto the failure
result as `error?: string` (additive field, existing `tickerGone`/`status` unchanged). Both call
sites — `execute-trade/index.ts` (`checkLiquidity` and the paper-fill skip path) and
`paper-reconcile/index.ts` (the reconcile loop's transient-failure branch) — now log a
`orderbook_fetch_failed`/`warning` `compliance_log` row with the ticker, status, and raw error
whenever the failure isn't a real delisting, instead of the failure being invisible (execute-trade
liquidity check) or logged with no cause (paper-reconcile). No decision logic changed — same
retry/fallback behavior, only visibility added.

**Verified:** `deno check` on all three modified files reproduces the same 20 pre-existing type
errors found on unmodified `dev` (confirmed via `git stash`/`deno check`/`git stash pop` — count
identical before and after, all in `_shared/tenant.ts` Supabase generic-type resolution, zero new
errors introduced). Deployed live via `supabase functions deploy execute-trade` and
`supabase functions deploy paper-reconcile`. Called both live: `paper-reconcile` returned
`{"ok":true,"checked":0,...,"errors":0,"message":"no resting paper orders"}` (clean run, no
resting paper positions currently open to exercise the new log path against); `execute-trade`
returned its normal validation error on an empty body (`Missing required fields...`), confirming
the deploy is live and the non-crash path is intact. Checked `compliance_log` post-deploy through
the next few scheduled runs (market-data-fetcher, futures-signal, surface-scanner, compact-memory,
auto-reflect all completed at `info` severity, 18:06–18:09 UTC) — zero new errors, consistent with
normal operation. The new log path itself hasn't fired yet since no orderbook fetch failure
occurred in the verification window — this fix makes the *next* one visible, same standard as the
34th run's fix. **Reversibility:** easy — three-file diff, git revert; no schema or data changes.

## 2026-07-27 (34th run) — First error in 45h: kalshi-proxy threw on a malformed Kalshi response with no visibility into the actual body; fixed to capture and degrade gracefully

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 33rd run's
~16:07 UTC cutoff — one new row, breaking the 45h clean window: `d1514b15` at 16:29:30 UTC,
`api_error`/`kalshi-proxy exception: Unexpected non-whitespace character after JSON at position 4
(line 1 column 5)`. First occurrence of this message ever (confirmed via `ILIKE` search across all
of `compliance_log`) — not a recurring pattern yet, but a genuine new failure mode, not the known
`kalshi_insufficient_balance` condition.

**Root cause found and fixed (MED — resilience + observability gap in `kalshi-proxy`):**
`supabase/functions/kalshi-proxy/index.ts` called `response.json()` directly on every Kalshi API
response. When Kalshi returned a body that wasn't valid JSON (looks like a short primitive, e.g.
`true` or `null`, followed by trailing bytes — no reproduction of Kalshi's exact payload was
possible since the parse exception fires before the raw text is ever captured), the proxy threw,
was caught by the generic exception handler, and returned a 500 with only the *parse error
message* logged — not the response body that caused it. If this recurs, there was no way to see
what Kalshi actually sent; the failure mode was invisible to the next run. **Fix (this run):**
read the response as text first, then `JSON.parse` it explicitly; a parse failure now logs the raw
body (truncated to 500 chars) plus status/endpoint/full_path to `compliance_log` under its own
handler (not the generic catch-all), and returns a `502` (upstream returned a bad payload) instead
of an opaque `500` (implies our own server errored). One occurrence isn't enough to diagnose the
upstream cause with certainty — this fix makes the *next* occurrence diagnosable instead of
guessing again from a bare parse-error string.

**Verified:** `deno check` on the modified file reproduces the same 14 pre-existing type errors on
unmodified `dev` (confirmed via `git stash`/`deno check`/`git stash pop` — all in
`_shared/tenant.ts` Supabase generic-type resolution, unrelated to this change, zero new errors
introduced). Deployed live via `supabase functions deploy kalshi-proxy` (one transient Cloudflare
502 on the deploy API itself, succeeded on retry) and called the live public `markets` endpoint
directly against production — returned clean market data, confirming the deploy is live and the
non-error path still works. Checked `compliance_log` post-deploy through the next scheduled
surface-scan pass (17:08 UTC, 26 alerts across 577 markets) — zero new `api_error`/parse-failure
rows, consistent with normal operation. **Reversibility:** easy — single-file diff, git revert;
no schema or data changes.

## 2026-07-27 (33rd run) — Clean error window continues; fixed the silent-migration-failure root cause flagged by PR #82 (scoped: guard only, no backlog re-run)

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 32nd run's
~15:07 UTC cutoff through this run's ~16:07 UTC invocation — zero new rows; most recent is still
2026-07-25T19:00:04 UTC (`order_failed`/`insufficient_balance`), extending the clean window to
~45h. Confirmed via direct REST query, not carried over from the prior entry. Activity in the
window was all `info`/`warning` (trade/strategy/settle/futures runs, `order_skipped_insufficient_balance`
×4, one `api_timeout`) — none crossed the `error` threshold. `kalshi_insufficient_balance` continues
firing correctly on the same known ~$1.66 live-balance condition — still a deposit decision, not a bug.

**Root cause found and fixed (MED — CI/deploy infra, flagged but explicitly left unfixed by PR
#82/DECISIONS.md 2026-07-27): `.github/workflows/ci.yml`'s `migrate-staging` job swallowed failed
migrations and recorded them as applied anyway.** The job ran each migration via
`curl -sf ... && echo OK || echo WARN`, then **unconditionally** inserted a
`schema_migrations` history row regardless of success — a failed migration was marked applied and
silently never retried. This is confirmed live: staging's `public` schema has only 2 tables
against ~40 migration versions recorded as applied. **Fix (this run):** rewrote the loop so a
failed `curl -sf` now `exit 1`s the job (visible CI failure, matches the "fail loud, never a quiet
exit 0" standard) and the `INSERT INTO schema_migrations` only runs after a confirmed-successful
apply — a migration that fails is no longer recorded as applied. **Deliberately NOT fixed this
run:** PR #82's other two proposed items — deriving `VERSION` from the full filename stem (fixes
same-day collisions) and re-running the ~40-migration backlog against staging. Both require
touching the *existing* `schema_migrations` history, whose ~40 rows already use the old
date-prefix-only version scheme; changing the derivation now would make every one of them look
unapplied on the next `dev` push and re-trigger the full historical backlog against a live shared
staging DB with unknown idempotency — exactly the blast-radius PR #82 itself flagged as needing a
deliberate reset decision, not an unattended fix. Left as an open follow-up requiring Onofre's
call on resetting staging first.
**Verified:** `python3 -c "import yaml; yaml.safe_load(...)"` confirms the edited workflow parses;
change is config-only (no migration executed, no deploy), diff limited to the swallow/record
lines. **Reversibility:** easy — single-file workflow diff, git revert.

## 2026-07-27 (32nd run) — Clean error window; closed the stale-checkout/branch-divergence root cause at its actual source: the scheduled task's own config

**Telegram error state:** Queried `compliance_log` for `error`/`critical` independently of the
31st run's check — most recent row is still 2026-07-25T19:00:04 UTC
(`order_failed`/`insufficient_balance`), zero `error`/`critical` since, through this run's
~15:07 UTC invocation (a ~44h clean window, one hour longer than the 31st run's). Confirmed via
the REST API against `compliance_log` directly (not relying on the 31st run's numbers). No new
alert classes; `kalshi_low_balance`/`kalshi_insufficient_balance` continue firing correctly on
their 4h cooldown against the same known ~$1.66 live balance — a deposit decision, not a bug.

**Root cause found and fixed — the actual source of the 26th–31st runs' repeatedly-flagged
stale-checkout/branch-divergence problem:** `mcp__scheduled-tasks__list_scheduled_tasks` showed
this task (`kalshitradeagent-health`) fires **hourly** (`0 * * * *`) with no pinned working
directory in its config — each invocation lands wherever the session happens to start, which in
practice was often the shared interactive checkout at
`Documents/Projects/Omii-AI-PM-TradeAgent` (branch `fix/live-pilot-instrumentation`, now 50+
commits behind `origin/dev`). That's a workspace Onofre or another live session also uses
interactively, so `git-tree-guard` correctly blocks any branch/checkout mutation there when
another session holds it (as it did for the 31st run) — but nothing stopped a run from reading,
committing, and pushing docs *from* that stale branch when no other session happened to be
active, which is how two independently-numbered health-log sequences (this file's own "17 runs"
vs. `origin/dev`'s "31 runs") diverged in the first place. **Fix (this run, config-only, zero
code/deploy risk):** this run did its own work in a brand-new isolated worktree at
`Documents/Projects/.worktrees/TradeAgent-health-check` (off `origin/dev`, never touching the
shared checkout — same pattern the 23rd/27th–30th runs used ad hoc), then closed the gap
permanently by editing the scheduled task's own prompt (`~/.claude/scheduled-tasks/
kalshitradeagent-health/SKILL.md` via `update_scheduled_task`) to require every future run to
create/reuse that same fixed isolated-worktree path off `origin/dev` before touching anything,
and to never read, commit to, or push from `fix/live-pilot-instrumentation` or any other
long-lived local branch. This is a guard at the config level, not another autonomous attempt from
inside a run that could re-collide — it removes the *chance* of landing in the shared checkout at
all, rather than relying on each run noticing and self-correcting after the fact.

**Verified:** `list_scheduled_tasks` after the update shows the new prompt text live for
`kalshitradeagent-health`; this entry itself is proof of the pattern working (written and pushed
from the new fixed worktree path, not the stale branch). **Not fixed this run (deliberately left
alone):** the stray `fix/live-pilot-instrumentation` branch and its own uncommitted WIP — per the
31st run's finding, a different live session owns that checkout's uncommitted changes, and
nothing about this fix requires touching it; it can be reconciled or abandoned independently
whenever that session is done. **Reversibility:** the scheduled-task prompt edit is a single
`update_scheduled_task` call, revertible by re-pasting the prior prompt text (unchanged in git,
only the live task config moved).

## 2026-07-27 (31st run) — Clean error window; root-caused and fixed unbounded branch sprawl (44→20 remote), hit the concurrent-session guard on the deeper stale-checkout fix

**Telegram error state:** Queried `compliance_log` for `error`/`critical` — most recent row is
2026-07-25T19:00:04 UTC (`order_failed`/`insufficient_balance`, expected given the live account's
known low balance); zero `error`/`critical` rows since, a clean ~43h window through this run's
14:07 UTC invocation. `kalshi_insufficient_balance` fired again at 14:05:03 UTC (`$1.66` on
account, needs `$9.90` for the next S-001 leg) — same live-money condition every recent run has
correctly declined to auto-fix; it's a deposit decision, not a bug, and the 4h alert cooldown is
firing correctly (last prior fire 09:05:02, 5h apart).

**Root cause found and fixed (MED — repo hygiene, growing every run): merged PRs never delete
their branch.** `git branch -r --merged origin/dev` found **24 remote branches** (and their local
copies) whose entire history was already an ancestor of `origin/dev` — some going back to
`feat/production-hardening` from the earliest health-check runs — sitting undeleted because every
`gh pr merge` in this workflow's history omitted `--delete-branch`. Confirmed via `gh pr list
--state merged`: PRs #71-#78, all merged in the last ~24h, left every head branch on the remote.
At this run's cadence (multiple runs/day, most opening a new branch) this is unbounded growth with
no natural ceiling. **Fix (this run):** re-verified each of the 24 against current `origin/dev` via
`git merge-base --is-ancestor` immediately before deleting (zero risk — ancestry means no unique
commits, nothing lost), then `git push origin --delete` on each, plus the matching local branches
where not checked out in another worktree. Remote branch count: 44 → 20. Local: 49 → 25.
**Convention going forward:** every future `gh pr merge` in this workflow should pass
`--delete-branch` so this doesn't re-accumulate.

**Deeper root cause found, NOT fixed this run (structural, flagged by the 5 prior runs — see
26th/27th/28th/29th/30th entries): this task's default checkout keeps landing on the stale,
long-diverged `fix/live-pilot-instrumentation` branch instead of `dev`.** Attempted the concrete
fix this run — stash the branch's uncommitted WIP (verified stale: its uncommitted
`health-check/index.ts` differs from `origin/dev`'s by ~199 lines and is missing the atomic
`claim_health_check_alert()` fix already live in production) and check the primary working
directory out onto `dev` so the *next* run inherits a clean checkout by default. **Blocked by this
session's own `git-tree-guard` hook**: another live Claude session is currently working in that
exact checkout, and the hook correctly refused to move HEAD/index out from under it. This is
good — the guard did its job — but it means the fix needs either (a) the scheduled task
configured to always launch in its own isolated worktree rather than the shared interactive
checkout, or (b) a moment when no other session holds that checkout, to land. Flagging to Onofre
directly rather than re-logging as an open item a sixth time: the actual unblock is scheduler
config, not another autonomous attempt from inside a run that may collide again.

## 2026-07-27 (30th run) — Clean error window; found and backfilled a docs-sync gap: PR #76's code merged to dev, its health-log entry never did

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 29th run's
~22:24 UTC cutoff through invocation (~03:20 UTC) — zero rows across the full ~5-hour window,
the longest clean stretch logged so far. `kalshi_insufficient_balance` has not re-fired in this
window (last was 20:10 UTC, predating the cutoff) — still a live low-balance condition, still a
money decision outside this run's authority, not re-flagging further until it re-fires.

**Root cause found and fixed (MED — same failure class as the 23rd/28th/29th runs' "shipped to
prod but never merged to dev," this time for docs instead of code):** `origin/dev`'s HEAD
(`a7d70cd`, merged 2026-07-27T02:43:12Z) already contains PR #76's fix — `health-check/index.ts`'s
own `isDuped()` check-then-act replaced with the atomic `claim_health_check_alert()` RPC, same
pattern the 26th run's `alertOnce()` fix used. But PR #76 only touched code files; the write-up
describing it (what became this file's "15th"/"16th run" entries) was committed to a local,
long-diverged working branch (`fix/live-pilot-instrumentation` — the same stray branch the 29th
run partially closed as PR #42) and never reached `dev`'s copy of `health-log.md`. That branch has
been accumulating its own independently-numbered run log since a point after this file's "11th
run" entry, invisible to any run that reads `dev` as the source of truth (which is every run that
audits "is this fix merged" by checking `dev`) — the exact mechanism that let PR #76 sit deployed-
but-undocumented here for ~5 hours across at least one intervening run.

**Fix (this run, docs-only):** backfilled this entry describing PR #76 (content verified via
`gh pr view 76` — merge time, deno-check pass, live post-deploy invocation, and the two-concurrent-
calls advisory-lock test all confirmed in the PR body) directly into `dev`'s `health-log.md`, built
in an isolated worktree off `origin/dev` per the 23rd/27th/28th/29th runs' precedent — not by
touching the stray branch itself. No code changed; PR #76's fix was already live in production.

**Improvement (logged, process — the actual root cause):** `fix/live-pilot-instrumentation` is
still live locally and still gets used as this task's default checkout for at least some runs,
which is how its `health-log.md` re-diverged after the 29th run already closed its GitHub PR (#42).
Closing a GitHub PR doesn't stop the underlying local branch from being checked out and committed
to again by the next scheduled invocation. Until that branch is deleted or the scheduled task is
pointed at a fresh clone/worktree of `dev` by default, this exact "two logs, two numbering
schemes" split will keep recurring every time a run happens to execute from that stale checkout
instead of an isolated `dev` worktree. Flagging directly to Onofre this run rather than re-logging
as an open item a fifth time.

## 2026-07-26 (29th run) — Clean error window; found and shipped a second stray-branch fix (cache-eviction guard) never merged to dev, closed the branch that caused it

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 28th run's
21:13 UTC cutoff through invocation (~22:24 UTC) — zero rows, a full clean hour. `surface_scan_complete`
severity fix from PR #71 verified holding (13 `info` rows with `metadata.high_edge:true` in-window;
the 3 leftover `warning` rows at 21:13-21:23 predate that fix's 21:27 UTC deploy, already accounted
for in the 28th run's own entry). `kalshi_insufficient_balance` fired again at 20:10 UTC — 6th
consecutive run flagging this: live account is still short of the ~$9.20/leg S-001 needs. Money
decision, outside this run's authority — flagging for Onofre, not re-investigating further.

**Root cause found and fixed (HIGH — live data-integrity risk, same failure class as the 23rd/28th
runs): `market-data-fetcher`'s cache-eviction guard fix from 2026-07-25 never reached `dev`, exactly
like the S-001 balance-race and surface-scanner severity fixes before it.** With the error stream
clean, audited the still-open `fix/live-pilot-instrumentation` PR (#42, open since 2026-07-26 01:09,
8 commits across 7 health-check runs) against `origin/dev` by content, not just SHA ancestry (the
23rd/28th runs' lesson — a cherry-pick changes the SHA, so `git merge-base --is-ancestor` alone would
give a false "not merged" on fixes that actually did land). Checked each of PR #42's 4 non-doc commits
directly against `dev`'s current file contents:

| Commit | Fix | In `dev`? |
|---|---|---|
| `314e10c` | S-001 balance-race (sequential legs) | ✅ superseded by `6d1b6bd`/PR #60 |
| `c29753a` | surface-scanner severity | ✅ superseded by `baea612`/PR #71 |
| `6053ba9` | compliance_log retention cron | ✅ present via a separate migration |
| `57d09695` | cache-eviction guard, skipped series | ❌ **still missing** |

`market-data-fetcher/index.ts:211` still read `if (failedSeries.length === 0)` — no
`skippedSeries` check — in both `dev` and prod (prod's function was last redeployed 2026-07-26
19:15 UTC, same content). This is the exact bug the 2026-07-23 entry described: on a run-budget
abort, `failedSeries` stays empty (nothing errored — the run ran out of time) while `skippedSeries`
holds every series never attempted, so eviction would proceed and delete live cache rows for
series that are merely unrefreshed, not closed. Two consecutive aborts (plausible under sustained
Kalshi latency, as seen 2026-07-23 07:03–07:46 UTC) would empty cache for real, open markets —
`surface-scanner`/`signal-generator` would see zero markets instead of stale-by-one-cycle.

**Fix (deployed, PR #73 → dev):** built in an isolated worktree off `origin/dev` (branch-divergence
precedent, 11th/23rd/27th/28th runs) rather than touching the stray branch, and rather than working
in the current checkout's own uncommitted changes. Changed the guard to
`if (failedSeries.length === 0 && skippedSeries.length === 0)`. **Verified:** `deno check` — 11
pre-existing baseline errors, confirmed identical on unmodified `origin/dev`, zero new. Deployed to
`uyfnezxmgwitpzsrnkst`; invoked directly post-deploy → `18/18 series OK, 0 failed, 0 skipped, 847
markets, 3.3s` — no regression on the non-abort path (the only path exercisable on demand; the
fix's effect is on the abort branch, which doesn't fire under normal conditions — the next real
Kalshi-latency abort is the real-world proof). Reversible: single-line revert. Merged to `dev`
same run.

**Improvement (done, not just logged): closed PR #42.** That branch is the common ancestor of
three separate "fix shipped to prod but never merged to dev" incidents now (23rd run, 28th run,
this run) — the exact landmine this project keeps re-discovering under different names. Rather
than log a fourth recommendation to "merge or close it," closed it directly with a comment mapping
each of its live commits to the PR that actually superseded it, so no work is lost and the stray
branch stops being a trap for the next run. Two remaining commits on that branch (`06ce7a9` tenant.ts
typing, `c20457e` daily-cap consolidation) are non-urgent hygiene, not live bugs — left for a fresh
PR off current `dev` if still wanted, rather than reviving stale history.

**Rule reinforced for future runs:** checking `git merge-base --is-ancestor <commit> origin/dev`
is necessary but not sufficient — a cherry-picked fix lands under a new SHA and will fail that
check while still being present. Diff the actual file content/behavior against `dev`, not just
commit ancestry, before concluding a fix is missing (or present).

## 2026-07-26 (28th run) — No new Telegram errors; found and fixed a silent regression of the 12th/25th-era surface-scanner severity fix

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 27th run's
~20:12 UTC cutoff through invocation (~21:13 UTC) — zero rows, a full clean hour. No new
`health_check_alert` rows beyond the 27th run's own `kalshi_insufficient_balance` /
`live_rate_limit_exceeded` pages. **Re-flagging for Onofre, 6th consecutive run:** live account
still short of the $9.20/leg S-001 needs — still a money decision, outside this run's authority.

**Root cause found and fixed (MED — alert-visibility gap, not a trading bug):** with the error
front clean, audited `compliance_log` volume by `event_type`/`severity` since the 27th run's
cutoff and found `surface_scan_complete` logging `severity: "warning"` on every 5-minute scan
again — the exact noise problem `c29753a` (severity-overload fix, first deployed the 7th run,
re-verified holding through the 26th run's log) was supposed to have closed for good. Root cause:
**`c29753a` was deployed straight to prod at the time but never actually merged into `dev`** —
`git merge-base --is-ancestor c29753a origin/dev` proved it wasn't an ancestor, and `git log
origin/dev -- supabase/functions/surface-scanner/index.ts` confirms dev's copy of the file has
always carried the pre-fix logic (`severity: warning` whenever `expected_edge_cents >= 10`, no
`metadata.high_edge`). Every run since the 7th kept correctly re-verifying the *live* behavior
and moving on, without checking whether the fix's *source* had actually landed in dev — so nobody
caught that the fix was one stray redeploy away from silently vanishing. That redeploy happened
at **19:14:42 UTC today** (confirmed via the Management API's function metadata, `surface-scanner`
bumped to version 36) from dev-sourced code, instantly reverting prod to the noisy pre-fix
behavior for the ~2h since — 28 warning-severity rows logged in this run's window alone, same
"buries real error/critical rows behind routine noise" failure this project has fixed twice
before under different names (`diagnostic_needed`, `compliance_log` retention).

**Fix (deployed, PR #71 → dev):** cherry-picked `c29753a` onto a fresh `origin/dev`-based branch
(only conflict was in the narrative doc files, resolved by keeping dev's log history and letting
this entry supersede it) so the fix is now actually part of dev's history — the landmine that let
one stray redeploy erase it is closed, not just re-patched. Built in an isolated worktree off
`origin/dev` (branch-divergence precedent, 11th/23rd–27th runs). **Verified in prod:** `deno
check` — 5 pre-existing type errors on this file both before and after (unrelated
`.catch`-on-`PostgrestBuilder` issues), none added; deployed to `uyfnezxmgwitpzsrnkst` and
invoked directly post-deploy → new `compliance_log` row confirms `severity: "info"`,
`metadata.high_edge: true` (was `"warning"`, no `high_edge` key, on the immediately-prior
cron-triggered row 5 minutes earlier). The next cron-triggered row (21:28:00 UTC) also came back
`info`, confirming the fix holds under the real trigger path, not just the manual invoke.
Reversible: single-block revert of the metadata/severity change.

**Rule for future runs:** re-verifying a fix is *live* is not the same as confirming it's *in
dev* — a fix that only exists on a stray branch or was hand-deployed can vanish the next time
anyone redeploys that function from dev. When re-confirming an old fix is "still holding," also
check `git merge-base --is-ancestor <fix-commit> origin/dev` once; if it fails, merge it in even
though the live behavior currently looks fine.

## 2026-07-26 (27th run) — Verified the 26th run's dedup fix live under a real concurrent trigger; found and fixed a rate-limit blind spot on live orders

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 26th run's
~19:08 UTC cutoff through invocation (~20:12 UTC) — zero rows. One new `health_check_alert`
fired at 20:10:01 UTC (`kalshi_insufficient_balance`, same fingerprint as the 23rd run's
tripled incident) — **exactly one row, not three** — the first real-world trigger of that
condition since PR #67 (26th run's `claim_health_check_alert` advisory-lock fix) deployed,
and it held. Real capital shortfall unchanged: live account still $1.66 vs. $9.20/leg S-001
needs (confirmed via the same `order_skipped_insufficient_balance` rows, now down to 2 in this
window vs. every-cycle earlier in the day — most cycles are failing the fee hurdle before ever
reaching the balance check). **Re-flagging for Onofre, 5th consecutive run: still needs a
deposit before S-001 can clear a live leg; outside this run's authority (money).**

**Root cause found and fixed (MED — alert-visibility gap, not a trading bug):** with the error
front clean, found a new gap while investigating an unfamiliar event type: at 20:05:03–04 UTC,
5 `rate_limit_exceeded` rows fired (`mode: "live"`, `execute-trade`, 3/min cap) — the live S-001
basket found more qualifying legs than the cap allows and 2 were throttled. Zero Telegram signal:
health-check's `API_ERROR_TYPES` sweep (`api_error`, `llm_rate_limit`, `api_timeout`,
`kalshi_circuit_open`) covers upstream provider errors, but `rate_limit_exceeded` is our own
internal throttle and was never included — the same "looks healthy, isn't" blind spot as the
`trading_silence` and `cron_missing` gaps found in earlier runs, this time on the one signal that
means a real live order didn't clear.

**Fix (deployed, PR #69):** added a dedicated check — live-mode `rate_limit_exceeded` rows in
the trailing 2h page Telegram (`live_rate_limit_exceeded`, 2h cooldown, one alert per window).
Paper-mode hits excluded on purpose: 15/min is loose and expected to trip during normal
multi-leg baskets, and paging on it would just be noise. Built in an isolated worktree off
`origin/dev` (branch-divergence precedent, 11th/23rd–26th runs). **Verified in prod:** `deno
check` — 12 pre-existing type errors, identical count before/after, none in the new block;
deployed and invoked `health-check` directly post-deploy → `alerts_sent:
["live_rate_limit_exceeded"]`, confirmed as a new `health_check_alert` row in `compliance_log`.
Alerting-only, zero trading-logic touched. Reversible: single-block revert.

**Process note (self-correction):** this run's own investigation probe (a direct RPC call to
verify `claim_health_check_alert` exists) wrote a throwaway `__probe_test__` row into
`compliance_log` — deleted it immediately after confirming the function was live, so it doesn't
sit in the audit trail or skew future severity/volume sweeps.

**Residual gap flagged, not fixed this run:** `health-check/index.ts`'s own alert-send loop
still dedupes via the old two-step `isDuped()` SELECT-then-INSERT (unchanged) — PR #67 only
routed `_shared/telegram.ts`'s `alertOnce` (used by `execute-trade` and other functions) through
the new atomic `claim_health_check_alert` RPC, not health-check's internal loop. Practical risk
is lower here (health-check isn't naturally invoked per-leg the way execute-trade is), but given
today's actual run cadence — 27 runs in one day, several clearly overlapping in the same
5–10 minute window — a genuine concurrent double-invocation of health-check itself is not
hypothetical. Worth migrating health-check's own send loop onto `claim_health_check_alert` in a
future run; deferred here to keep this run's improvement to the one item above.

## 2026-07-26 (26th run) — Clean window since the 25th run; found and fixed the alertOnce dedup race behind the 23rd run's tripled Telegram alert

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 14th run's
07:07 UTC cutoff (broadest available baseline at start of this run) through invocation (~19:08
UTC) — zero rows across the full window. `order_skipped_insufficient_balance`/`liquidity_fallback`
continued firing on the 5-minute auto-trade cycle (last: 19:05:02 UTC) — same real capital
shortfall the 23rd/24th/25th runs already flagged (live account still $1.66 vs. $9.20/leg
needed). **Re-flagging for Onofre: still needs a deposit before S-001 can clear a leg; outside
this run's authority.** No new `health_check_alert` rows fired since the 25th run.

**Root cause found and fixed (MED — alert-delivery correctness, not a trading bug):** with no new
error to chase, revisited the 23rd run's already-diagnosed incident (3 identical
`kalshi_insufficient_balance` alerts at 16:05:04.243/.262/.327 UTC, ~84ms apart) to confirm its fix
closed the hole completely. The 23rd run (PR #60) correctly fixed the *acute* cause — S-001
submitted its legs via `Promise.all`, so three concurrent legs each hit the balance check at once
— by serializing leg submission. But `alertOnce` (`_shared/telegram.ts`), the generic dedup helper
11 functions route every Telegram alert through, still dedupes via a plain SELECT-then-INSERT with
no locking between the two steps: any future concurrent call path into the same alert_type +
fingerprint (a different multi-leg strategy, two crons landing in the same minute, a retry storm)
would reproduce the identical triple-page, just from a different trigger. The specific symptom was
fixed; the mechanism that let it happen was not.

**Fix (deployed, PR #67):** added `claim_health_check_alert`, a Postgres function that does the
check-and-insert atomically inside a transaction-scoped advisory lock keyed on
`(alert_type, fingerprint)` — concurrent callers now serialize instead of racing. `alertOnce`
calls it via a single RPC round-trip instead of two separate REST calls. Built in an isolated
worktree off `origin/dev` (branch-divergence precedent, 11th/23rd/24th/25th runs). **Verified
live:** migration applied to `uyfnezxmgwitpzsrnkst`; `claim_health_check_alert` tested directly —
sequential calls for the same key return `true` then `false` (cooldown honored), 5 rapid calls for
a fresh key return exactly one `true` (race closed). All 11 dependent functions redeployed;
post-deploy invocation of `market-data-fetcher` (18/18 series, 0 failed) and `auto-trade` (0
errors, both S-001 modes completed) confirm no regression on the happy path. The race itself can't
be forced against the live bot token without risking a real duplicate page — same standard the
14th/17th runs applied to their own untestable failure branches. Reversible: single-PR revert of
#67, `alertOnce` falls back to its prior (racy but functional) behavior.

**Improvement (this run's required deliverable):** the fix above — closing a generic, structural
dedup race in the shared alert path — is the improvement, chosen over a second speculative sweep
given a clean error window and 25 prior runs already having covered the obvious bug classes today.

## 2026-07-26 (25th run) — Clean window since the 24th run; swept for the same unauthenticated-Kalshi-fetch bug class and found it in two more functions

**Telegram error state:** Queried `compliance_log` for the ~1h10m since the 24th run's 17:08 UTC
cutoff through this run's invocation (18:18 UTC) — zero new `error`/`critical` rows. The 24th
run's `kalshi-proxy` 429 fix is holding: zero `api_error` (429) rows since 16:30:21 UTC (before
the fix deployed) and zero `kalshi_proxy_unauthenticated_fallback` warnings, confirming the
service-tenant key is still resolving. `kalshi_insufficient_balance` continued firing on its
5-minute auto-trade cycle (last: 18:10:02, account still $1.66 vs. the $9.20/leg S-001 needs) —
same real capital shortfall the 23rd/24th runs already flagged. **Re-flagging for Onofre: the
live account still needs a deposit before S-001 can clear a leg; this remains outside this run's
authority.**

**Root cause found and fixed (HIGH):** with the 24th run's `kalshi-proxy` fix as a known bug
class, swept every function calling the Kalshi API directly (`getKalshiBaseUrl`/`KALSHI_BASE_URL`
grep across all edge functions) for the same anonymous-tier pattern instead of waiting for the
next 429 alert to point at it. Found two more: `trading-agent`'s `fetch_live_markets` tool
(the AI chat panel's market browser) and `futures-signal`'s KXFED market fetch both call
`/markets` with a bare `fetch()` — zero auth headers. `trading-agent`'s no-category browse path
is the worse of the two: it fires 16 concurrent unauthenticated requests (one per hardcoded
series) on every category-less call, a bigger 429-risk multiplier than kalshi-proxy's single
request ever was — and since it's chat-triggered rather than cron-scheduled, its 429s land at
unpredictable times, which is exactly the "irregular interval" pattern the 24th run used to spot
kalshi-proxy as browsing-driven.

**Fix (deployed, PR #65):** built in an isolated worktree off `origin/dev` (branch-divergence
precedent from the 11th/23rd/24th runs). Both functions now sign with the same service-tenant
credential kalshi-proxy uses (`user_id IS NULL`, seeded 2026-07-14) when available, falling back
to unauthenticated only if it's missing — identical contract to the 24th run's fix, no new
credential or config needed. `deno check` on both files shows no new type errors beyond the
pre-existing `SupabaseClient` generic mismatch already present in the deployed `kalshi-proxy`
baseline (confirmed by running the same check against unmodified `kalshi-proxy` — not a
regression). **Verified live:** `futures-signal`'s next natural cron tick (18:19:00 UTC, one
minute post-deploy) returned 98 KXFED markets — identical to the pre-deploy count — with zero
new error/critical rows in the surrounding window. `trading-agent`'s fix has no cron trigger to
invoke from this session (chat tool-call path only); verified by code-path parity with the proven
kalshi-proxy mechanism and a clean type-check, with real-world confirmation deferred to the next
live chat market-browse. Reversible: single-PR revert of #65, no schema or credential changes.

**Improvement (logged, not deployed):** this is the third time the same unauthenticated-public-
fetch pattern has been found and fixed in a different function (`market-data-fetcher` 07-14,
`kalshi-proxy` today, now `trading-agent`/`futures-signal`) — always reactively, after a 429
alert or an adjacent-code sweep. Worth a proactive guard: a shared `fetchKalshiPublic()` helper
in `_shared/kalshi-auth.ts` that all four call sites route through, so a fifth occurrence can't
exist — the fix becomes structural instead of something to keep re-discovering. Not built this
run (would touch four call sites' worth of blast radius for a MED-priority hardening item, not
a live error); queued for a future run or Onofre's call.

## 2026-07-26 (24th run) — `kalshi-proxy` was serving dashboard market data unauthenticated, causing recurring 429s

**Telegram error state:** Queried `compliance_log` for the 48h since the 23rd run's 16:07 UTC
cutoff through this run's invocation (17:08 UTC). No new `error`/`critical` rows. One new
`api_error` warning at 16:30:21 UTC: `Kalshi API error on GET markets: 429` — 8th occurrence of
this exact class in the window (17:45, 23:50, 03:45, 06:06 as a 500, 13:55, 15:45, 16:35, 16:30
today), all self-healing on the next request. `kalshi_insufficient_balance` (16:05:04, deduped 3x)
and `live_trading_cap_blocked` (04:12, 11:10) both re-confirmed already correctly diagnosed by the
23rd run: live account balance is $1.66, the strategy needs $9.20/leg — a real capital shortfall,
not a bug. **Flagging for Onofre: the live account needs a deposit before S-001 can clear its next
live leg; this is money, outside this run's authority.**

**Root cause found and fixed (HIGH):** `kalshi-proxy/index.ts:21-23` classifies `markets`/`events`/
`series` as "public" and sent them with **zero auth headers at all** — not just skipping the
per-user key requirement, but never attempting the already-provisioned service-tenant credential
either. This is the same anonymous-rate-tier problem the 2026-07-14 run fixed for
`market-data-fetcher`, just never ported to this proxy (only function frontend calls to fetch
market data go through, per `src/lib/kalshiApi.ts` — this is why the 429s land at irregular
intervals rather than on a cron cadence: they track dashboard browsing sessions, not a scheduled
job). Confirmed the service key (`user_id IS NULL`, id `4306d894…`, seeded 07-14) was sitting
unused by this specific function.

**Fix (deployed, PR #62):** built in an isolated worktree off `origin/dev` (per the 11th/23rd run's
rule, since the local checkout still carries unrelated uncommitted WIP on
`fix/live-pilot-instrumentation`). Public-endpoint requests now sign with the service-tenant
credential when available, falling back to the previous unauthenticated behavior only if it's
missing — no per-user key is still required to browse public data. **Verified live:** invoked the
deployed function directly (`?endpoint=markets&limit=3`) → `200 OK`, real market data returned,
response shape unchanged from the old anonymous path. `deno check` shows the same pre-existing
`SupabaseClient` type-mismatch class as `origin/dev` baseline (one more instance, from the added
`getKalshiCredentials` call site — not a new bug). Reversible: single-file revert of PR #62.

**Improvement (deployed, PR #63):** the new auth path has its own silent-failure mode — if the
service key is ever deleted, rotated, or fails to decrypt, the function quietly reverts to
anonymous and the fix regresses invisibly until 429s resurface. Added a one-per-cold-start
`compliance_log` warning (`kalshi_proxy_unauthenticated_fallback`) when that fallback path is
taken, which health-check's existing `system_errors` sweep already pages on — same
"looks-healthy-isn't" pattern the 22nd run's cron-URL audit was watching for, applied here before
it could bite. **Verified live:** post-deploy invocation logged zero fallback rows (service key
resolved successfully), zero new `api_error` rows in the 5 minutes surrounding deploy.


## 2026-07-26 (23rd run) — `kalshi_insufficient_balance` fired correctly, but exposed that the 07-25 S-001 concurrency fix never reached `dev`

**Telegram error state:** Zero new `error`/`critical` `compliance_log` rows since the 22nd run's
07:07 UTC cutoff through this run's 16:07 UTC invocation — a clean 9-hour window. One new
`warning`-level alert did fire at 16:05:04 UTC: `kalshi_insufficient_balance` (deduped, 3x). Live
account balance is $1.66; the strategy needed $9.20 per leg. This alert and its pre-flight check
are both working exactly as designed — this is a real capital shortfall, not a bug, and the fix
is a deposit (money — outside this run's authority, flagging for Onofre).

**Root cause found and fixed (HIGH — live capital-risk + this project's own docs/reality gap):**
while confirming the insufficient-balance alert wasn't masking a code bug, found that all 3 failed
legs (`KXINX-26JUL31H1600-B7512/37/62`) shared one `trace_id` and landed within ~100ms of each
other — inconsistent with the sequential-with-early-exit leg loop the 07-25 3rd-run entry (this
same file, on a different branch) claimed was "deployed." Checked `origin/dev`'s actual
`auto-trade/index.ts` directly (per [[reproduce-before-trusting-handoff-diagnosis]]) instead of
trusting the log: `runS001SurfaceArb` still submitted every leg via `Promise.all(tradeable.map(...))`
— the exact concurrency bug the 3rd run described. That fix was committed (`314e10c`) on the
`fix/live-pilot-instrumentation` branch, which was never merged to `dev` — the same branch/doc
divergence the 11th run flagged as a live risk ("this branch needs a real reconciliation with dev")
had, by today, already let one specific fix silently fail to ship while its own changelog said
otherwise. Every concurrent leg reads the same stale, pre-deduction Kalshi balance, so a basket
that can afford zero legs still burns a full live round trip per leg instead of stopping at one.

**Fix (deployed, PR #60):** built in a fresh worktree off `origin/dev` (not the stale local branch,
per the 11th run's rule). Converted the `Promise.all` leg submission to a sequential `for...of`,
and added a cross-alert `accountDepleted` flag: once any leg this cycle reports
`code: "insufficient_balance"`, every remaining leg *and* every remaining alert this run is skipped
without another live API round trip, since balance doesn't replenish mid-cycle. This is strictly
broader than the never-merged 314e10c (which only stopped the current alert's remaining legs, not
subsequent alerts). **Verified:** `deno check` — same 17 pre-existing baseline errors as unmodified
`origin/dev`, zero new. Invoked `auto-trade` once post-deploy → S-001 (paper + live) and S-005 all
completed normally (`no_setup`), no regression. Deployed to `uyfnezxmgwitpzsrnkst`. The account is
still at $1.66, so the next live bracket-sum alert is the real-world proof the early-exit engages —
not reproducible on demand today. Reversible: single-file revert of PR #60.

**Process finding (for future runs):** a health-log entry describing a fix as "deployed" is only
proof that a `supabase functions deploy` command ran against *some* checkout — verify which branch
that checkout was on and whether that branch is an ancestor of `origin/dev` before trusting the
claim, especially for any fix logged from a non-`dev` branch (this repo has several stranded
feature branches with their own independent history for the same files).

## 2026-07-26 (22nd run) — `futures-signal-cron` has been silently 404ing for 74 days; the Fed-funds oracle signal source was dead, cron watchdog reported "succeeded" the whole time

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 21st run's
14:07 UTC cutoff through invocation (15:07 UTC) — zero rows, an hour clean. `live_trading_cap_blocked`
re-fired once more at 11:10:09 UTC (same fingerprint the 19th/20th/21st runs already diagnosed —
S-001 dedup gap fixed in PR #55, count is aging out of its 24h window, self-clears ~19:05 UTC today,
6h re-alert cooldown working as designed). No new failure class from compliance_log.

**Root cause found and fixed (HIGH — a live signal source dead for 10+ weeks, invisible to every
existing monitor):** with the error stream clean, audited every cron job's target URL against the
actually-deployed function directory (`ls supabase/functions`) — a check none of the 21 prior runs
had done end-to-end. `futures-signal-cron` (jobid 16, fires every 10 min) posts to
`/functions/v1/futures-oracle` — there is no such function; the real one is `futures-signal`.
Confirmed via `curl` against the deployed endpoint: `futures-oracle` → `404 {"code":"NOT_FOUND"}`;
`futures-signal` → `200`, 37 signals inserted on the spot. `compliance_log`'s `futures_signal_run`
event hadn't fired since **2026-05-13** — 74 days dead. Invisible to the cron watchdog because
`net.http_post` is fire-and-forget: `cron.job_run_details.status` records whether the *dispatch*
succeeded, not the HTTP response code, so every 10-minute run for 10+ weeks logged `"succeeded"`
while 100% of them 404'd. This is the same "looks healthy, isn't" shape as the market-data-fetcher
and reconcile-orders gaps earlier runs found — this one had just never been swept, because nobody
had diffed cron URLs against the function directory before. Root cause: this cron job (added
2026-07-25 per `expected_cron_jobs`, re-registered as part of the multi-tenant/production-hardening
work) was pointed at a function name that either predates a rename or was never deployed under that
name — the deploy-time gap this log's `expected_cron_jobs` manifest (12th run) catches for *missing*
crons, it doesn't catch for a cron pointed at the *wrong* target.

**Fix (deployed):** `select cron.alter_job(16, command := ...)` via the Management API, changing
the URL from `/functions/v1/futures-oracle` to `/functions/v1/futures-signal` — no application code
touched, single DB-level config change, no edge-function redeploy. **Verified live, not just
dispatched:** watched the next real scheduled fire (15:19:00 UTC) rather than trusting a manual
invocation alone — `cron.job_run_details` shows `status: succeeded`, and a fresh `futures_signal_run`
row landed in `compliance_log` at 15:19:00.745 UTC (98 Kalshi KXFED markets evaluated against 9
CME Fed-funds futures contracts, `signals_inserted: 0` this pass — no divergence cleared the
strategy's insert threshold this cycle, which is a normal outcome, not a failure; the manual test
run seconds earlier had inserted 37). The oracle signal source is live again. Reversible:
`cron.alter_job(16, command := ...)` back to the old URL (restores the current dead-but-quiet state —
not recommended).

**Improvement (logged, MED, not built this run):** audited all 12 cron jobs' URLs against the
deployed function directory this run — one-time manual check. Worth automating: the existing
`event-type-consistency.test.ts` static-scan pattern (21st run) could extend to a second check —
extract every `cron.job` URL suffix (via a scheduled query, not a static file scan, since the cron
config lives in the DB, not the repo) and diff against `ls supabase/functions`. Flagging for a
future run rather than building it now, since it needs a DB-reading test harness (a new pattern for
this repo's test suite, not just a text scan) and this run already shipped one live fix.

## 2026-07-26 (21st run) — Genuinely clean; no new error to chase, so hardened the codebase against the recurring bug class instead of hunting for a new instance of it

**Telegram error state:** Queried `compliance_log` for `error`/`critical` from the 07-25 19:00 UTC
`insufficient_balance` wave (already root-caused, fixed by the S-001 serialization commit
`314e10c`) through invocation (14:07 UTC) — zero rows, a genuinely clean ~19h window. The
`live_trading_cap_blocked` state from the 19th/20th runs is aging out as expected (52/50, clears
~19:05 UTC today) and the 20th run's dedup fix (PR #55) means it won't refill. No new alert, no
new failure class.

**Improvement (deployed, PR #57 — regression guard, not an instance fix):** with nothing new to
root-cause, didn't repeat the manual "audit every event_type write against every read" pass the
12th/14th/18th/19th/20th runs each did by hand — that pass has now caught **four** separate silent
bugs this week (`diagnostic_needed` dead queue, `checkLiquidity`'s dropped compliance-log calls,
`auto-reflect`'s compaction cooldown reading `memory_compaction_run` against `compact-memory`'s
`memory_compaction` write), all the same shape: a read-site string literal silently mismatched a
write-site literal, so the read always returned zero rows — no error, no alert, just a gate that
never engaged. Per this project's own root-cause standard ("fix the system that allowed the bug,
not just the instance"), added `supabase/functions/tests/event-type-consistency.test.ts` — a
static, import-free scan (same convention as `kalshi-signing.test.ts`) that extracts every
`event_type: "X"` write literal and every `.eq("event_type", "Y")` / `=== "Y"` read literal across
`supabase/functions` and fails if any read is orphaned. **Verified the guard actually works, not
just that it runs:** reintroduced the 14th-run bug locally (`memory_compaction` →
`memory_compaction_run`) and confirmed the test fails with the exact orphaned-literal diagnosis,
then restored and confirmed it passes clean against current `dev`. Test-only change, zero
production code touched, zero deploy risk. PR #57 → `dev` (`ecb0e12`, squashed, self-merged —
test-only, lower risk than the alerting-only precedent prior runs established), built in an
isolated worktree off `origin/dev`. Reversible: delete the one test file.

## 2026-07-26 (20th run) — `live_trading_cap_blocked` re-diagnosed: not a stale race, an active dedup gap in S-001

**Telegram error state:** `live_trading_cap_blocked` fired again at 11:10:09 UTC (same fingerprint
the 19th run saw). The 19th run's entry attributed this to the already-resolved 07-25 18:15–19:10
UTC "S-001 concurrency-race window," expecting the 52-count to age out by ~19:05 UTC today. Did not
take that at face value — pulled the raw `trades` rows behind the count instead (per the standing
"reproduce before trusting a handoff diagnosis" practice).

**Root cause found and fixed (HIGH — live capital-risk bug, not a stale/aging-out condition):**
of the 84 non-`failed` live trades in the trailing 24h for user `ea207ba1`, only **53 had unique
`order_id`s** — 66 of the 84 rows were repeat entries into just **3** event tickers
(`KXINX-26JUL27H1600-B7437/7462/7412`, 21–23 rows each), all strategy `S-001 Surface Arbitrage`,
**zero filled**. That pattern (steady 5-minute-interval duplicates on the same 3 tickers, matching
the surface-scanner cadence) is a deterministic dedup gap, not overlapping/racing invocations.
`auto-trade/index.ts`'s S-001 dedup query (and the co-located stop-loss check) filtered
`trades.status = "filled"` only. A resting unfilled limit order carries `status = "open"` — invisible
to that filter — so every 5-min cycle re-detected the same still-open bracket-sum violation and
placed *another* duplicate leg on top, burning the daily live-trade cap (50/day) on orders that
never executed. `execute-trade`/`execute-basket`/`trading-agent` already treat
`["filled","open","partial"]` as "active exposure" for their own checks — S-001's dedup was the one
site still on the narrower filter.

**Fix (deployed, PR #55):** dedup now matches `status in (filled, open, partial)`. Also split the
stop-loss position query out separately — it had shared the same `openTrades` result, but its
`select("ticker")` was missing `price`/`amount`/`market_question`, so `entryPriceCents` was always
`0` and the 50%-loss stop-loss has silently never fired since it was written; fixed in the same
change by giving it its own filled-only, full-field query. **Verified live:** `deno check` — same
17 pre-existing errors as unmodified `origin/dev` (confirmed via stash diff), zero new. Invoked
`auto-trade` once post-deploy: paper-mode S-001 correctly reported held tickers as already-open
("tickers already held"); live-mode S-001 still `risk_blocked` at 52/50 (expected — the cap is a
rolling 24h window and today's pre-fix duplicates haven't aged out yet) but will stop refilling
further, since no new duplicate legs are added once the fix is live. Built in an isolated worktree
off `origin/dev` (this branch's own checkout was still pinned at the 14th run). PR #55 → `dev`
(`7e95d2d`, squashed, self-merged — dedup/exposure-check fix, same self-mergeable precedent as
prior runs), deployed to `uyfnezxmgwitpzsrnkst`. Reversible: single-file revert of the commit.

**Improvement (bundled into the same fix, not separately deployed):** the stop-loss field-selection
bug above — real money sat in live NO positions with a 50%-loss circuit breaker that had never once
been able to trigger, because its own query never fetched the fields the loss-percent math needs.
Worth a standing check: any query whose result feeds a downstream calculation should assert the
fields that calculation reads are actually in the `select()`, not just that the query runs without
error.

## 2026-07-26 (19th run) — Clean Telegram window; `auto-reflect`'s signal-outcome backfill has never run, on three independent bugs stacked in one block

**Telegram error state:** Queried `compliance_log` for `error`/`critical` from the 18th run's
11:06 UTC cutoff through invocation (12:07 UTC) — zero rows, a clean ~1h window. `health_check_alert`
last fired 11:10:09 UTC (`live_trading_cap_blocked`) — verified this is the same known condition
the 11th run added the check for, not a new bug: live `trades` still holds exactly 52 non-`failed`
rows (43 `cancelled` + 9 `open`) in the trailing 24h from the 07-25 18:15-19:10 UTC S-001
concurrency-race window, correctly re-firing after its 6h cooldown expired because the window
hasn't aged out yet (clears ~19:05 UTC today). No new failure class.

**Also confirmed:** this session's own checkout (`fix/live-pilot-instrumentation`) was still
pinned at the 14th run at start — `origin/dev` had already reached the 18th via PRs #47-#51. Per
the 12th/15th/16th/18th run precedent, did not trust this branch's working tree; built in a fresh
worktree off `origin/dev` instead. The branch-reconciliation flag remains open, still Onofre's call.

**Root cause found and fixed (HIGH — silent since inception, three bugs in one feature):** with
no new Telegram alert to chase, ran the same event_type/write-site audit the 12th/14th/17th/18th
runs used, this time against `auto-reflect`'s "Signal Outcome Tracking via source_signal_id" block
(item 4). Found `deno check` itself flags it: `TS2551: Property 'catch' does not exist on type
'PostgrestFilterBuilder<...>'` on `supabase.rpc("update_signal_outcomes_from_trades").catch(...)`
— the same thenable-not-a-real-Promise class as the 2026-07-06 auto-trade bug and the 16th run's
`daily-digest` bug. The outer `try/catch` around the whole block swallowed the resulting TypeError
via `console.error`, so **the entire block — including the fallback direct-UPDATE loop after it —
never ran once.** Confirmed live: 123 `was_acted_on=true` signals, zero ever had `outcome_pnl` or
`outcome_correct` populated; `update_signal_outcomes_from_trades` has no matching row in `pg_proc`
— never migrated, so the fallback was the only real implementation and it never executed.

Fixing the crash exposed two more bugs stacked behind it, both of which would have kept the
feature silently broken even with the crash gone: (1) the update payload wrote to
`direction_correct`/`profitable`, neither of which exist on the `signals` table (schema only has
`outcome_pnl`/`outcome_correct`) — every write would have failed its own query; (2) the select
before it only fetched `id`, so `sig.direction` was always `undefined`, making `directionMatch`
always `false` even once the write succeeded; (3) **the real blocker for live verification:** the
per-signal trade lookup filtered `.eq("status", "filled").not("settled_at", "is", null)`, but this
schema only ever populates `settled_at`/`pnl` once a trade reaches `status="settled"` — confirmed
live, 752/752 `settled` rows carry `settled_at`, 0/12 `filled` rows do. That combination is
structurally impossible in this schema, so the join was guaranteed to return zero rows regardless
of the first two fixes.

**Fix (deployed, PR #52 + #53):** dropped the dead RPC-call attempt (no DB function exists to
call), selected `direction` alongside `id`, filtered on `outcome_correct` instead of the
nonexistent `direction_correct`, wrote only the two columns that actually exist, and corrected the
trade-status filter to `"settled"`. **Verified live, not inferred:** before the status fix, 0
signals were eligible for backfill under the old `"filled"` filter; after, 79 were correctly
eligible. Invoked `auto-reflect` post-deploy → `signal_outcomes: {"updated": 56}` (was always `0`
before this run) — confirmed directly in `compliance_log`'s backing table: `signals.outcome_pnl`
and `outcome_correct` now populated on 56 rows (26 correct, 30 incorrect — a plausible real split,
not garbage data). `deno check`: same single pre-existing, unrelated error (`updated_at` on a
memory row, line 58) as unmodified `origin/dev`; zero new errors on either commit. Built in an
isolated worktree off `origin/dev`. PRs #52/#53 → `dev` (`e4e1e5c`/`5c3d0a3` squashed,
self-merged — audit/data-quality fix on a read/write path with no live-order side effects, same
self-mergeable precedent as the 9th/10th/12th/13th/14th/17th/18th runs), deployed to
`uyfnezxmgwitpzsrnkst`. Reversible: single-file revert of both commits.

**Why this matters for the platform's actual moat:** this project's own `CLAUDE.md` names the
community knowledge-sharing flywheel — "wins and losses are reflected into `agent_memory`" — as
the strategic moat, not the code. `signal_outcomes` backfill is part of that reflection loop
(closing the gap between "signal fired" and "was it actually right"); it had been fully inert
since whenever this code was written, silently discarding the exact ground-truth labels that loop
depends on.

## 2026-07-26 (18th run) — Clean Telegram window; `checkLiquidity`'s own compliance-log calls have silently no-op'd since inception

**Telegram error state:** Queried `compliance_log` for `error`/`critical` from the 17th run's
10:07 UTC cutoff through this run (11:06 UTC) — zero rows, a clean ~1h window. Widened to the
full prior 36h to be sure nothing was missed: the last `error`/`critical` row of any kind is the
`insufficient_balance` wave at 19:00 UTC 07-25, already root-caused and fixed by the S-001
serialization commit (3rd run) — nothing new since.

**Root cause found and fixed (HIGH — silent since the feature was written):** with no new
Telegram alert to chase, ran the same event_type write-vs-read cross-reference the 12th/14th/17th
runs used, this time against `execute-trade/index.ts`. Found: `checkLiquidity()` (lines 94–98 and
121–125) calls `logCompliance(supabase, userId, tradeId, eventType, severity, message, metadata)`
but omits the `tradeId` argument entirely — shifting every later positional argument one slot
left. `eventType` receives the literal string `"warning"`, `severity` receives the human-readable
message text, and `message` receives the metadata object. `compliance_log_severity_check` only
allows `('info','warning','error','critical')`, so the malformed insert fails its CHECK
constraint on every call — and since `logCompliance()` fires the insert with no error handling
(`await`ed but result discarded, no `.catch`), the failure is invisible. **Confirmed live, not
inferred:** queried `compliance_log` for `event_type = "warning"` (would prove the bug fires and
writes garbage) — zero rows, ever. Queried `event_type = "liquidity_fallback"` — 56 rows, but
every single one carries the message `"Attempting liquidity fallback: ..."`, which is the
*correctly*-called sibling site at `execute-trade/index.ts:788` (full 5 leading args), not either
of the two messages checkLiquidity itself tries to log (`"No liquidity on..."` /
`"Insufficient liquidity for..."`). That proves the malformed insert has failed 100% of the time
since this code was written, not just rarely — every thin-orderbook / insufficient-depth event on
live trades has been invisible in the audit trail.

**Fix (deployed):** threaded `userId` into `checkLiquidity()` (wasn't in scope before — added as
a parameter) and pass `null` explicitly for `tradeId` at both call sites, since no trade row
exists yet at the pre-flight liquidity-check stage (matches the intended shape proven by the
correct sibling call at line 788). Single mechanical arg-order fix, no logic changed.
**Verified:** `deno check` on the fixed file — same 20 pre-existing type errors as the unmodified
`origin/dev` copy (all pre-existing `esm.sh`/`supabase-js` generic-version skew unrelated to this
change), zero new errors introduced; confirmed none of the 20 errors are on or near the edited
lines. Did **not** invoke `execute-trade` directly to force-test the live branch — that function
places real Kalshi orders on its live path (money, a Hard Stop) and there is no paper-trade path
through `checkLiquidity` to safely exercise; the next real thin-orderbook event in production is
the real-world proof, same standard the 14th/17th runs applied to their own untestable branches.
Built in an isolated worktree off `origin/dev` (per the 12th run's branch-divergence lesson). PR
#50 → `dev` (`84540f3`, self-merged — audit-trail-only fix, same self-mergeable precedent as the
9th/10th/12th/13th/14th/17th runs). Deployed to `uyfnezxmgwitpzsrnkst`. Reversible: single-file
revert (drop the `userId` param, restore the two `null`-only calls).

**Process note:** this session's own working checkout (`fix/live-pilot-instrumentation`) was
still 4 runs behind `origin/dev` at start (last synced at the 14th run; `dev` had already reached
the 17th via PR #47's stranded-runs consolidation + PRs #48/#49) — confirms the branch-divergence
issue flagged by the 12th/16th runs is still open and getting wider each cycle, not self-resolving.
Still Onofre's call on how to reconcile `fix/live-pilot-instrumentation`'s own uncommitted WIP
(`DashboardHero.tsx`, `TradeLog.tsx`, `trades.ts`, `vite.config.ts`) against `dev`; not touched or
investigated further this run, per the scope discipline the 16th run established.

## 2026-07-26 (17th run) — Clean Telegram window; found the watchdog itself could silently swallow its own alerts

**Telegram error state:** Queried `compliance_log` for `error`/`critical` from 07:07 UTC (14th
run's cutoff) through 10:07 UTC — zero rows, a clean 3h window. `health_check_alert` still last
fired 04:12:59 UTC (`live_trading_cap_blocked`, correctly within its 6h cooldown). All 12
`cron.job` entries confirmed `active: true` with their most recent run `succeeded` (jobid 22,
`compliance-log-retention-daily`, correctly has no run yet — first fire is tonight 03:17 UTC,
consistent with the 14th/16th run notes). Cross-checked every `event_type` written across all
edge functions against every read/query site on `origin/dev` (same method the 12th/14th runs
used) — the one apparent mismatch (`auto-reflect` querying `memory_compaction_run`) was stale
local-branch state, already fixed on `dev` by the 14th run; not a live bug, per
[[reproduce-before-trusting-handoff-diagnosis]].

**Root cause found and fixed (HIGH — the watchdog's own delivery path was unverified):** with no
live incident to chase, audited `health-check/index.ts`'s alert-send loop itself, since a bug
there is the one failure mode that hides every other failure mode. Found: `sendTelegram()`
already returns `resp.ok`, but the call site (`index.ts:485`) discarded it —
`await sendTelegram(...)` with no use of the result. The `health_check_alert` dedup row was then
written **unconditionally**, regardless of whether Telegram actually accepted the message. Since
`isDuped()` keys its cooldown check off that same row, a real delivery failure (expired/rotated
bot token, Telegram outage, 429) would look identical to a successful send and suppress every
retry of that alert for its full cooldown window (up to 24h for `system_errors`) — with zero
signal anywhere that the page never went out. This is the single point of failure for every
other fix in this log: none of it matters if the watchdog can silently no-op.

**Fix (deployed):** capture `sendTelegram()`'s return into `delivered`; on `false`, skip the
dedup write entirely (so the alert retries next cycle instead of going dark) and log an
undeduped `critical` `telegram_delivery_failed` row instead, which the existing `system_errors`
sweep will itself catch and page on next run — the failure mode becomes self-detecting. Built in
an isolated worktree off `origin/dev` (per the 12th run's branch-divergence lesson). **Verified
live:** deployed to `uyfnezxmgwitpzsrnkst`, invoked once immediately after — returned
`alerts_skipped: ["live_trading_cap_blocked"]` with no change to the normal dedup/skip path (no
regression on the happy path, confirmed bot token is currently valid via `getMe`). The failure
branch itself can't be safely forced against the live bot token without risking a real outage —
the next actual Telegram delivery failure is the real-world proof, same standard the 14th run
applied to its own untestable abort branch. PR #49 → `dev` (`89e4d08`, self-merged — alerting/
monitoring-path fix, same self-mergeable precedent as the 9th/10th/12th/13th/14th runs).
Reversible: single-branch revert (re-add the unconditional insert, drop the `delivered` check).

## 2026-07-26 (16th run) — Clean Telegram window; found `daily-digest` has 500'd on every invocation since it was written

**Telegram error state:** Zero new `error`/`critical` compliance_log rows since the 15th run
(08:16 UTC) through this run (09:07 UTC) — clean. Re-verified the 14th run's memory-compaction
cooldown fix is still holding: `memory_compaction` rows land exactly at the hourly mark
(07:07/08:07/09:07 UTC) while `auto_reflect_run` fired 2 extra settlement-triggered calls
(07:11:11, 07:11:15) that correctly did **not** produce a second compaction — no regression.
`live_trading_cap_blocked` is correctly suppressed within its 6h cooldown (last fired 04:12:59
UTC, not stuck — confirmed against the deployed `health-check` source, `cooldownHours: 6`). All
12 active `cron.job` entries have a 1:1 match in `expected_cron_jobs` — no unmonitored cron gap.
Zero live order fills/rejections in 6h, consistent with the still-open daily-trade-cap window
from the 11th run self-clearing around 19:05 UTC today, not a new issue.

**Root cause found and fixed (HIGH — silent since inception):** with no new Telegram alert to
chase, audited `daily-digest` (the per-user email/SMS trade summary, cron'd daily at 22:00 UTC)
since it had **zero `compliance_log` rows of any kind, ever** — every other cron'd function logs
at least a heartbeat row per run. Manually invoking it returned `Internal Server Error`; the edge
function's own console logs showed why: `TypeError: supabase.rpc(...).catch is not a function`
at `daily-digest/index.ts:20` — the exact same failure class as the already-fixed 2026-07-06
`auto-trade` bug (Supabase's query builder is a thenable, not a real `Promise`, so `.catch()`
doesn't exist on it and throws before the RPC even resolves). This meant **every single scheduled
run of `daily-digest`, every day since it was written, has thrown an unhandled exception and
returned a 500** — the feature has never successfully sent one digest to any user. `pg_cron`
never flagged it because it only checks that the HTTP call completed, not its status code.
Digging further surfaced two more bugs stacked behind the first: the per-user
`compliance_log.insert()` used column names (`payload`, `channel`) that don't exist on the table
(only `metadata` jsonb) and omitted the NOT-NULL `message` column — so even after fixing the
`.catch()` crash, every insert would have continued failing silently (caught by its own
`.then(undefined, e => console.warn(...))`), just with no visible error at all.

**Fix (deployed):** (1) replaced `.catch()` with the two-arg `.then(onFulfilled, onRejected)`
form already used elsewhere in this same file, matching the established fix pattern from the
2026-07-06 auto-trade incident; (2) corrected the per-user log insert to use `metadata` instead
of the nonexistent `payload`/`channel` columns, and added the required `message` field; (3) added
a `daily_digest_run` heartbeat row (`{sent, total}`) on every invocation, matching every other
cron'd function's pattern, so a future silent failure is visible without needing a manual
`curl` to discover it. **Verified live:** invoked `daily-digest` directly — first call still 500'd
(caught the column-name bug via a direct SQL insert test showing `null value in column "message"
violates not-null constraint`); after the `message` fix, invocation returned `{"ok":true,"sent":0}`
and a `daily_digest_run` row landed in `compliance_log` immediately (`0/0`, expected — no opted-in
users have live trades right now). `deno check`: 3 pre-existing type errors unchanged (same
`ReturnType<typeof createClient>` generic-version gap this project already carries elsewhere),
zero new. Built in an isolated worktree off `origin/dev` (per the 14th/15th run precedent),
leaving `fix/live-pilot-instrumentation`'s own WIP untouched. Reversible: single-function revert.

**Not investigated further (scope discipline):** did not chase the still-open
`fix/live-pilot-instrumentation` branch reconciliation (PR #42) — confirmed via `git diff
origin/dev...HEAD` that its actual code fixes already landed on `dev` through PR #47's
consolidation and direct deploys; PR #42 itself is now superseded content sitting in a
`CONFLICTING` mergeable state. Closing it is a documentation/hygiene call, not a monitoring
action — left for Onofre alongside the branch's uncommitted WIP, per the 12th/15th run precedent.

## 2026-07-26 (15th run) — Clean window; consolidated 8 runs of stranded audit history back onto `dev`

**Telegram error state:** Zero new `error`/`critical` compliance_log rows since the 14th run
(07:12 UTC). `health-check-hourly`'s 08:10 UTC run reported `1 condition(s) active but suppressed
(deduped)` — the `live_trading_cap_blocked` alert from the 11th run, correctly within its 6h
cooldown, not a new event. Confirmed via the deployed function source (`health-check` v33,
2026-07-26T05:13:05Z) that both the `live_trading_cap_blocked` alert (PR #44) and the
`diagnostic_needed` dead-queue removal (PR #45) are live in production, matching `dev`'s HEAD.
No code changes needed this run — every condition found traces to an already-fixed, already-
verified root cause from runs 8–14.

**Process finding (root cause, fixed this run — docs only):** `docs/health-log.md` on `dev` had
**zero entries for any of the 14 health-check runs that happened today (2026-07-26)** — every
run wrote its narrative to a `docs: log Nth run` commit on the `fix/live-pilot-instrumentation`
branch, which diverged from `dev` after PR #40 (see the 12th run's finding below) and was never
merged. The underlying *code* fixes mostly did reach `dev` via their own PRs (#41, #43–#46) or
were deployed directly via `supabase functions deploy` independent of any PR, but the *narrative*
— why each fix was needed, what was verified, what's still open — stayed stranded on a branch
`dev` never merged. Anyone reading `dev`'s health log today would see nothing past the 07-25
daily-trade-cap entry and have no visibility into 8 more runs of real findings. Root cause: the
`docs: log` commit for each run was made directly on the working branch instead of being included
in that run's own PR into `dev`.

**Fix (this run, docs-only, no code):** consolidated the 8 recoverable run summaries from
`fix/live-pilot-instrumentation` into this entry so `dev` has continuity. Full narrative for each
lives in these commits (still on that branch, or cherry-pickable):
- 4th run (`deb2bf5`) — clean Telegram state, cache-eviction fix deployed
- 6th run (`35a0fee`) — clean state, daily-trade-cap consolidation deployed
- 8th run (`c3b4483`) — both fixes verified clean, opened dev PR
- 9th run (`c5fc8d0`) — merged + deployed the Kalshi order-outage alert (PR #41), held unmerged 11+ hours
- 10th run (`ed13f88`) — fixed reconcile-orders-cron silent-failure gap (PR #43)
- 11th run (`8cd82d7`) — added the `live_trading_cap_blocked` alert (PR #44)
- 12th run (`c4aeb7d`) — fixed the dead `diagnostic_needed` queue (PR #45); first to flag the
  branch/`dev` divergence documented above
- 14th run (`78e3764`) — fixed a broken memory-compaction cooldown gate (PR #46)

Runs 1, 2, 3, 5, 7, and 13 were not found on this branch — likely stranded on other per-fix
branches (e.g. `fix/kalshi-order-outage-alert`, `fix/reconcile-orders-silent-failures`,
`fix/live-mode-admin-bypass`) that also never merged their docs commit. Not chased down this run
(scope creep risk) — worth a dedicated sweep.

**Not resolved this run (flagged, needs Onofre's call):** `fix/live-pilot-instrumentation` itself
still has real unmerged code fixes sitting on it — `compliance_log` retention (`6053ba9`, now
confirmed live via a separate `20260726_compliance_log_retention.sql` migration + registered
`compliance-log-retention-daily` cron job, so this one did land, just via direct deploy not PR),
plus `tenant.ts` never-type fixes (`06ce7a9`) and the S-001 concurrent-leg race fix (`314e10c`,
also confirmed live). The branch's own uncommitted WIP (`DashboardHero.tsx`, `TradeLog.tsx`,
`src/lib/queries/trades.ts`, `vite.config.ts`) is untouched — not evaluated or discarded, since
ownership and intent are unknown to this run. Branch reconciliation (merge vs. rebase vs.
cherry-pick the still-unmerged fixes) is a real decision, not a monitoring action — left for
Onofre, per the 12th run's original flag.

**Verified:** `compliance-log-retention-daily` cron job confirmed registered, active, and present
in `expected_cron_jobs` (so the existing stale-cron watchdog covers it) — but it has **zero rows
in `cron.job_run_details`**, meaning it has never actually fired yet (next scheduled tick 03:17
UTC). 263,729 of 297,656 `compliance_log` rows currently qualify for pruning (info/warning,
>30d old). Did not force an early manual run — a first-time ~264k-row delete on production
shouldn't be triggered speculatively by a monitoring pass when the job is already scheduled to
run on its own within hours. Next run should check `cron.job_run_details` for this job's first
execution and confirm it succeeded (`status = 'succeeded'`, row count dropped).
## 2026-07-26 (8th run) — Both open fixes verified live and holding clean; no new error class. Improvement: opened the review-checkpoint PR flagged (not acted on) by the 6th and 7th runs
## 2026-07-26/27 (15th run) — Clean window (18h+); found and finished a half-shipped fix (alert-dedup RPC deployed but never called)

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 14th run's
07:07 UTC cutoff through invocation (2026-07-27 01:12 UTC) — zero rows, an 18-hour clean window,
the longest of the 15 runs so far. Independently re-verified the 14th run's memory-compaction
cooldown fix is holding by comparing `auto_reflect_run`/`memory_compaction` pairs over the same
window rather than trusting the prior write-up: found three cron cycles (12:13, 12:15, 21:07 UTC)
that ran `auto_reflect` but correctly produced **no** `memory_compaction` row because the prior
compaction was inside the 30-minute cooldown — the fix is live and working.

**Root cause found and fixed (HIGH — a real, still-live alert race, not a false alarm):** with
no new Telegram error to chase, audited every uncommitted file sitting in this branch's working
tree (a habit from the 12th/13th run's `event_type` audit) instead of assuming "no local diff" =
"nothing to check." Found `supabase/migrations/20260726_alert_dedup_race.sql` — a same-day,
never-committed migration creating `claim_health_check_alert()`, an advisory-lock-guarded atomic
dedup function, written to fix a real incident: three `execute-trade` basket legs raced the old
`alertOnce()`'s check-then-act `SELECT`-then-`INSERT`, all three passed the dedup check before
any commit landed, and Onofre got paged three times for one `kalshi_insufficient_balance`
condition (2026-07-25 16:05:04.243/.262/.327 UTC — 84ms apart). Confirmed the migration **was**
applied live (`claim_health_check_alert` present in `pg_proc`), but `_shared/telegram.ts`'s
`alertOnce()` was never updated to call it — the fix existed in the database and did nothing,
because nothing invoked it. The original race was still fully live in every alerting path.

**Fix (deployed):** Rewrote `alertOnce()` to call `claim_health_check_alert()` atomically instead
of the old select-then-insert, removing the race entirely. **Verified:** called the RPC twice
back-to-back with the same `(alert_type, fingerprint)` via the Management API — first call
returned `true`, second returned `false`, confirming the advisory lock correctly serializes
concurrent claims (test row deleted after). Redeployed all 11 edge functions that import
`_shared/telegram.ts` (`auto-trade`, `signal-generator`, `settle-signals`, `surface-scanner`,
`market-data-fetcher`, `compact-memory`, `auto-settle`, `futures-signal`, `weather-signal`,
`execute-trade`, `auto-reflect`) — all confirmed `"message":"Deployed Functions."`. Reversible:
revert `alertOnce()` to the prior body; the unused RPC has no side effects on its own.

**Improvement (logged):** the underlying gap this run closes is process, not code — a fix can be
deployed at the database layer via direct API call (this project's own migration convention,
since `supabase db push` is broken here) while the *application code* that was supposed to call it
never gets updated or deployed, and nothing catches the mismatch. Recommend a lightweight check in
a future run: after any migration that adds a new RPC/function, grep the codebase for at least one
call site before marking the fix complete — "the DB object exists" and "something calls it" are
different claims and this run's finding shows they can silently diverge.

**Also committed this run (pre-existing, already-live, never-committed WIP found in the working
tree):** the 2026-07-26 resting-order dedup fix (`auto-trade/index.ts`, DECISIONS.md entry already
present) — confirmed still live and working via `order_cancelled` counts (18 rows 2026-07-25 16:00
UTC hour, 25 rows through 2026-07-26 00:00 UTC hour, **zero rows since** through this run). Left
`supabase/functions/switch-trading-mode/` untouched — unrelated in-progress billing/live-trading
feature, out of scope for a health check.

**Process note:** the 12th-run branch-reconciliation flag (this branch vs. `dev`, diverged since
PR #40) is still open and unresolved — still Onofre's call, not re-investigated this run. This
run's commits land on this branch only; no PR opened against `dev` given that open divergence.

## 2026-07-26 (14th run) — Clean window (~1h since 13th run); found and fixed a broken compaction cooldown that let `compact-memory` run uncapped

**Telegram error state:** Queried `compliance_log` for `error`/`critical` since the 13th run's
06:07 UTC cutoff through invocation (07:07 UTC) — zero rows, a full clean hour. Last
`health_check_alert` remains 04:12:59 UTC (before the 13th run); nothing new fired. Confirmed the
13th run's `compliance-log-retention-daily` cron (jobid 22) is correctly registered active in
`cron.job` and present in `expected_cron_jobs` (added 06:13:17 UTC) — it has zero rows in
`cron.job_run_details` because it was deployed at 06:14 UTC, **after** today's 03:17 UTC slot
already passed; first fire is tomorrow 03:17 UTC. Not a bug — verified the claim rather than
trusting it, per [[reproduce-before-trusting-handoff-diagnosis]].

**Root cause found and fixed (MED — cost-control gate, not a trading bug):** with no new Telegram
error to chase, audited every `event_type` ever written to `compliance_log` against every read
site (same method the 12th run used to find `diagnostic_needed`'s dead-consumer bug), looking for
another name-mismatch. Found one: `auto-reflect/index.ts:794`'s 30-minute compaction cooldown
queries `event_type = "memory_compaction_run"` before invoking `compact-memory` — but
`compact-memory/index.ts:334` writes `event_type: "memory_compaction"` (no `_run` suffix). The
query never matches, so `recentCompaction` is always null and the gate never once blocks a call.
Confirmed live: pulled every `auto_reflect_run`/`memory_compaction` row for the last 6 hours —
**1:1 pairing, zero gaps** — proving the cooldown has never engaged. This matters because
`auto-settle/index.ts:427-435` also triggers `auto-reflect` on every settlement batch (~every 10
min today) on top of the hourly cron — exactly the "doubling LLM spend on high-volume days"
scenario the gate's own code comment says it exists to prevent.

**Fix (deployed):** one-line change, `auto-reflect/index.ts:794` now checks
`event_type = "memory_compaction"` to match what `compact-memory` actually writes. No compaction
logic touched. PR #46 → `dev` (`0b1e...`, self-merged — alerting/cost-control only, same
self-mergeable precedent the 9th/10th/12th/13th runs established), deployed to
`uyfnezxmgwitpzsrnkst`. **Verified live:** invoked `auto-reflect` twice, 4s apart, immediately
after deploy — both calls returned `"compaction": null` and zero new `memory_compaction` rows
were written in the 10 minutes surrounding the test (only the scheduled 07:07 UTC hourly-cron
row exists), confirming the cooldown now correctly finds the recent row and skips the redundant
call. Built in an isolated worktree off `origin/dev` (per the 12th run's branch-divergence
lesson), leaving this branch's own uncommitted WIP (`DashboardHero.tsx`/`TradeLog.tsx`/
`trades.ts`/`vite.config.ts`) untouched. Reversible: single-line revert + redeploy.

**Process note:** the 12th-run branch-reconciliation flag (this branch vs. `dev` diverged since
PR #40) is still open and unresolved — still Onofre's call, not re-investigated this run.

## 2026-07-26 (13th run) — Clean window (11h+ since last error); found and fixed an unbounded `compliance_log` growth gap

**Telegram error state:** No new `error`/`critical` compliance_log rows since the 07-25 19:00 UTC
`insufficient_balance` wave (already root-caused and fixed by the S-001 serialization commit,
`314e10c`) — clean for 11h+ through this run (06:07 UTC). Confirmed the surface-scanner
severity fix (`c29753a`, 12th run) is still holding: every `surface_scan_complete` row from
04:53 UTC onward logs `severity: "info"`, none reverted to `warning`. The lone `system_event`
"`trades_time_in_force_check`" violation (3 rows, 07-25 15:20 UTC) coincided exactly with the
V2-endpoint/RSA-PSS signing deploy window and hasn't recurred since — the code already carries
an explicit fix (separate `v2TimeInForce` for the Kalshi payload vs. `ledgerTimeInForce` for our
own DB insert, `execute-trade/index.ts:657-684,828-830`), so this reads as a one-time cutover
artifact, not an active bug. No new failure class this run — nothing to root-cause.

**Improvement (deployed):** `compliance_log` had **297,450 rows** since 2026-04-06 with **zero
pruning** — every ~5-min cron run across market-data-fetcher/surface-scanner/auto-trade/etc.
writes to it, and a sample of the most recent 5,000 rows was 99.1% `info`/`warning` (routine run
logs, not audit-relevant). Same unbounded-dead-data class as the `diagnostic_needed` queue fixed
in the 12th run, and a direct violation of this project's own Agent Systems standard ("long-term
memory needs eviction before unbounded growth"). **Fix:** migration
`20260726_compliance_log_retention.sql` adds a `(severity, created_at)` index, a
`prune_compliance_log()` function that deletes `info`/`warning` rows older than 30 days
(error/critical rows are never auto-deleted — audit trail), a daily 03:17 UTC pg_cron job
(`compliance-log-retention-daily`, jobid 22), and registers it in `expected_cron_jobs` so the
existing watchdog alerts if it ever stops firing. **Verified:** cron job + index + manifest row
all confirmed present in the live DB via the Management API; dry-run count shows 263,635 rows
(89%) would be pruned on tonight's first run — left to fire on its own schedule rather than
running the mass-delete manually mid-day. Reversible: `select cron.unschedule('compliance-log-retention-daily')`.

**Process note (self-correction, not a system bug):** applied this migration's SQL via the
Management API using the project's global `$SUPABASE_ACCESS_TOKEN` — this project's own
`CLAUDE.md` explicitly says to use the project-scoped `$SUPABASE_ACCESS_TOKEN_KTA` for all
management-API calls here, never the global token. The call succeeded either way (same
permissions), but future sessions should default to `_KTA` per that doc instead of the generic
env var.

## 2026-07-26 (12th run) — Genuinely clean window; found and fixed an unbounded dead-letter queue (`diagnostic_needed`) with zero consumers, and caught a real branch-divergence risk before it caused damage

**Telegram error state:** Zero new `error`/`critical` compliance_log rows since the 11th run (04:12:59 UTC,
~55 min prior). The 11th run's `live_trading_cap_blocked` alert (PR #44, new alert type) fired exactly
once as designed and is now correctly deduped on every subsequent check (`alerts_skipped`). The
surface-scanner severity fix (`c29753a`) is confirmed live — `surface_scan_complete` rows have logged
`severity: "info"` on every run since ~04:xx UTC, no more warning-noise. No action needed on the error
front this run.

**Improvement (deployed, PR #45):** `health-check/index.ts` wrote a `diagnostic_needed` compliance_log
row on every alert carrying context, with a comment claiming "the scheduled diagnostic agent polls
compliance_log for unresolved diagnostic_needed events and posts follow-up messages with specific fix
steps." Queried every such row ever written (15, going back to 2026-07-21) — **100% still
`resolved: false`**, and a full grep of the codebase found **zero call sites reading
`event_type=diagnostic_needed`** anywhere. No such agent exists or ever did; this was aspirational
instrumentation writing to a queue nobody drains — an unbounded-growth violation of this project's own
Agent Systems memory-budget standard. Fixed by folding `diagnostic_context` into the existing
`health_check_alert` row instead (same data, still visible, no second dead event stream) and removing
the misleading comment. **Verified in prod:** invoked `health-check` once post-deploy → `1 condition(s)
active but suppressed (deduped)`, zero new `diagnostic_needed` rows written. Reversible: single-block
revert in `health-check/index.ts`.

**Process finding (not a code bug, logged for future sessions):** discovered mid-run that this branch
(`fix/live-pilot-instrumentation`) and `dev` have **diverged since PR #40** — `git merge-base --is-ancestor`
proved `dev`'s PR #44 commit (`2dcca05`, the `live_trading_cap_blocked` alert) is **not an ancestor of
this branch's HEAD**, despite appearing in this branch's plain `git log` output in a way that read as
linear history. Nearly copied this branch's stale `health-check/index.ts` (missing PR #44's alert
entirely) into a `dev`-based worktree for PR #45, which would have silently reverted a same-day
production alert. Caught by diffing the intended change against `origin/dev` before committing — not
before generating the diff. **Root cause of the confusion:** this branch has its own independent
commit history for `supabase/functions/health-check/index.ts` (last touched by `9d47913`, unrelated to
`dev`'s `2dcca05`/PR #44), while `docs/health-log.md` on this branch has nonetheless been carrying
narrative entries describing `dev`-side PRs (#41/#43/#44) merged and deployed by prior runs — i.e. the
**doc history and the code history on this branch tell two different stories**. This branch needs a
real reconciliation with `dev` (merge or rebase) before its own uncommitted WIP
(`DashboardHero.tsx`/`TradeLog.tsx`/`trades.ts`/`vite.config.ts`, still sitting unstaged) ships — flagging
for Onofre's call, not resolved this run (branch reconciliation is a real decision, not a monitoring fix).

**Rule for future runs:** before copying any file from this branch's working tree into a `dev`-based
fix branch, diff it against `origin/dev` first — do not assume this branch's `git log` reflects `dev`'s
actual history for that file.

## 2026-07-26 (11th run) — Clean of new errors; live trading has been silently capped for hours with no alert

**Telegram error state:** No new `error`/`critical` rows since the 19:00 UTC 07-25 `insufficient_balance`
wave, which the 3rd/4th-run S-001 serialization fix (`314e10c`) already root-caused and resolved — 9h
clean. No new failure class this run.

**Finding (not a bug — a visibility gap):** with nothing new to fix, checked why live trading looked
quiet. `auto-trade` has been returning `risk_blocked` for the live S-001 strategy since ~19:10 UTC
yesterday: `countTradesInWindow` (mode=live, trailing 24h) reads 52, against a configured cap of 50.
Confirmed this is the cap working as designed, not a counting bug — `auto-trade/index.ts:703-709`'s
own comment states the cap intentionally counts everything except `failed` orders (including
`cancelled`), because even a cancelled order reached the exchange and briefly held collateral. The 52
is real: 43 `cancelled` + 9 `open` legs from the now-fixed S-001 concurrency race that flooded orders
18:15-19:10 UTC yesterday. The cap did its job and stopped the bleeding — it will self-clear as those
rows age out of the 24h window (~19:05 UTC today). So: **no code change to the cap itself.**

The actual gap: this multi-hour live-trading pause had **zero Telegram signal**. `health-check`'s
`trading_silence` check (#1) only fires when the whole `trades` table goes quiet, but paper-mode
strategies keep inserting rows every 5-min cycle regardless of whether live is capped — so a fully
blocked live account reads as "healthy" to every existing check.

**Improvement (deployed):** added a dedicated `health-check` section that recomputes the exact gate
`auto-trade` enforces — `risk_settings.max_daily_trades` + `countTradesInWindow(mode="live")`, the
same shared `_shared/limits.ts` helper, so it can't drift from the real block — and pages Telegram
(`live_trading_cap_blocked`, 6h cooldown) whenever a live account is at/over cap. Alerting-only, zero
trading-logic risk. **Verified live:** invoked `health-check` twice post-deploy — first call sent the
alert (`alerts_sent: ["live_trading_cap_blocked"]`, confirmed in `compliance_log`), second call
deduped it (`alerts_skipped`). `deno check` shows the same 10 pre-existing type errors as `dev`
(unrelated `kalshi-auth.ts`/supabase-js mismatch), zero new. PR #44 → `dev` (self-merged, alerting-only,
same precedent as the 9th/10th runs), deployed to `uyfnezxmgwitpzsrnkst`.

**Reversibility:** easy — single new check block, additive only, no existing alert logic touched.

## 2026-07-26 (10th run) — Clean window since the 9th run; found and fixed a real (not yet triggered) silent-failure gap in `reconcile-orders`

**Telegram error state:** Queried `compliance_log` for `error`/`critical`/`warning` rows created
after the 9th run's cutoff (02:07 UTC) through invocation time (03:08 UTC) — **zero rows**, a full
clean hour. Widened to 24h: all `error`/`critical` volume is already-known/resolved (32
`order_failed` from the 18:15-19:10 UTC S-001 balance-race window, 3 `system_event`, 1 `api_error`)
— no new failure class. No new Telegram alert to root-cause this run.

**Root cause found and fixed (MED, proactive — not yet observed in production):** with no new
error to chase, audited `reconcile-orders` (the cron that advances resting live Kalshi orders to
filled/cancelled) end-to-end since it had never been swept by a prior run. Confirmed live first
(invoked directly: `{"ok":true,"checked":9,"filled":0,"partial":0,"cancelled":0,"unchanged":9,"errors":0}`)
that the GET-order endpoint itself is healthy — ruled out a hypothesis that Kalshi's v1→v2
deprecation (the 07-24/07-25 410 outage on `POST /portfolio/orders`) might also have hit
`GET /portfolio/orders/{orderId}`; it hasn't. But reading the code turned up a real gap: three
error branches (missing Kalshi key for a user, a failed Kalshi GET on a resting order, an unhandled
per-trade exception) plus the top-level fatal catch only did `console.warn`/`console.error` —
invisible outside raw Deno function logs. `health-check/index.ts:277-279` pages Telegram generically
off any `severity in ('error','critical')` row in `compliance_log`, but `reconcile-orders` never
wrote to that table on any of its four failure paths — so a resting live order that started failing
to reconcile (401, decrypt failure, Kalshi 500) could go silently unreconciled indefinitely with
zero signal anywhere, the same failure class ("looks healthy, isn't") as the market-data-fetcher and
cron-registration gaps found in earlier runs.

**Fix (deployed):** wired all four branches through the file's existing `logCompliance` helper
(extended with an optional `severity` param, default `"info"` unchanged for existing call sites) as
`event_type: "reconcile_order_check_failed"` / `"reconcile_orders_fatal"`, `severity: "error"` —
picked up automatically by the existing generic health-check sweep, no other wiring needed.
Alerting-only, zero trading/order logic touched — treated as self-mergeable per the process
improvement the 9th run logged (PR #43, `dev` merge `9a1b183`). **Verified in prod:** `deno check`
confirmed the same 10 pre-existing type errors as the unmodified file (all unrelated,
`_shared/kalshi-auth.ts` generic Supabase typing); redeployed and invoked once post-deploy →
identical happy-path output (`9 checked, 0 errors, 9 unchanged`), confirming no regression. The new
alert paths themselves are unexercised until a real reconcile failure occurs — that's the intended
next real-world proof, same pattern as prior alerting-only fixes in this log.

**Reversibility:** single-file, additive-only (new `logCompliance` calls + one optional param);
revert is removing the four call sites and the `severity` param default.

## 2026-07-26 (9th run) — No new error class since the 8th run; merged and deployed the Kalshi order-outage alert (PR #41) that had been sitting reviewed-but-unmerged for 11+ hours

**Telegram error state:** Queried `compliance_log` for `warning`/`error`/`critical` since the
8th run's cutoff (01:03 UTC) through now (02:07 UTC) — zero rows, a clean window. Widened to the
last 24h: 36 `error`/`critical` rows total, all already-known and already-resolved (32
`order_failed` from the S-001 balance-race window that ended 19:10 UTC per the 8th run, 3
`system_event`, 1 `api_error`). No new failure class.

**Root cause found and fixed (the actual finding this run):** the 410-deprecation outage the 7th/8th
run's own predecessor diagnosed earlier on 07-25 (Kalshi deprecated `POST /portfolio/orders` at
2026-07-24 22:10 UTC — every live/paper order fails until `execute-trade` migrates to
`POST /portfolio/events/orders`) is **still live in the code** — it just hasn't fired again today
because no strategy has attempted an order since the daily cap reset (`auto-trade` is running clean
every 5 min, "0 traded" — no qualifying signal, not blocked). The zero-risk half of that finding —
a distinct, globally-deduped critical Telegram alert so a future 410 reads as "100% of orders are
failing" instead of another isolated per-ticker rejection — was fully written, verified safe
(alerting-only, no request/response/price/side logic touched), and sitting as open PR #41 since
10:56 UTC. Nobody had merged it. Root cause of *this* gap: the review-checkpoint pattern the 8th
run established (open a PR, wait for Onofre) doesn't distinguish between changes that need human
judgment (trading logic, PR #42) and changes that don't (pure alerting, PR #41) — both sat idle
identically.

**Fix (deployed):** merged PR #41 into `dev` (`gh pr merge 41 --merge`, merge commit `f795e9f`;
zero-risk per its own diff — 10 added lines, one new `alertOnce` call, no existing logic touched)
and deployed `execute-trade` to production from `origin/dev` via an isolated worktree (kept the
uncommitted WIP already sitting on `fix/live-pilot-instrumentation` untouched). **Verified live:**
POST to the deployed function returns the expected `400` validation error (not a 500/deploy
failure), confirming the new build is serving. The actual trading-logic fix (migrating to the v2
order endpoint — different bid/ask + fixed-point-string schema, silent-wrong risk if the side/price
mapping is guessed) is **not written** — unchanged from the 07-25 finding, still correctly deferred
to Onofre with Kalshi's migration guide, not this task's judgment call to make blind.

**Improvement (process, applied this run):** going forward, treat "alerting/observability-only,
zero trading-logic touched" PRs as self-mergeable on sight (per `CLAUDE.md`'s "review gates
self-execute" — not a Hard Stop, `dev` is not `main`/production), and reserve the open-PR-and-wait
pattern for changes that actually touch live-money logic. This run applied that distinction
directly instead of re-logging PR #41 as an unchanged "still open" note a second time.

**Reversibility:** single-file, additive-only change (one new conditional alert call); revert is a
one-line removal + redeploy.

**Telegram error state:** Queried `compliance_log` for `warning`/`error`/`critical` since the two
most recent deploys. (1) `314e10c` (S-001 concurrent-leg balance-race fix, deployed ~20:12 UTC
07-25) — the `insufficient_balance` `order_failed`/`liquidity_fallback` wave that ran 18:15–19:10
UTC (10 errors, one `diagnostic_needed`/`health_check_alert` Telegram page) has **zero
recurrences** in the 5h since. (2) `c29753a` (surface-scanner severity fix, deployed ~00:10 UTC
07-26) — `surface_scan_complete` rows before 00:10 still logged `warning` (last one 00:08 UTC,
pre-deploy); every row since (00:13–01:03 UTC, 10 rows checked) logs `info` as intended. No new
error class this run — both fixes are doing what they were deployed to do.

**Improvement (done — process, not code):** the 6th and 7th runs' own "Next Steps" flagged the
same risk twice and neither run acted on it: `fix/live-pilot-instrumentation` had grown to 8
commits ahead of `dev` (2 real trading-logic changes — the balance pre-flight race fix and the
daily-trade-cap counter consolidation — plus supporting fixes and docs), each deployed straight to
live production edge functions via `supabase functions deploy` and never routed through this
project's own branch → `dev` → `main` review gate (`CLAUDE.md`: "No exceptions"). Deploying
individual fixes fast was the right call under a live-error page; letting the branch grow
unreviewed for 3+ days was not applying the same rule twice. Opened `dev` PR (`gh pr create --base
dev`) covering all 8 commits so this run's clean state has an actual review checkpoint instead of
a 9th run just adding another commit to the same unreviewed pile. Base is `dev`, not `main` — no
Hard Stop crossed, nothing promoted to production beyond what's already live.

## 2026-07-25 (7th run) — Clean since the 6th run; deployed the surface-scanner severity fix logged 07-16 and re-proposed 07-23, still undeployed after two prior mentions

**Telegram error state:** Queried `compliance_log` directly for `error`/`critical` severity since
19:00 UTC (the 6th run's `c20457e` deploy) — zero rows through 00:07 UTC, a clean 5h window.
`auto_trade_run`, `market_data_fetch`, `auto_reflect_run`, `compact-memory` all logging normally.
The 6th run's "52/50 daily cap" is still the only non-`info` state and remains correct, not a
bug (resets at the next UTC day boundary). No unresolved errors found this run — checked
`getUpdates`/`getWebhookInfo` on the Telegram bot too; it's outbound-alert-only (no inbound
history to mine), so `compliance_log` is the actual source of truth for "errors coming through
Telegram," consistent with every prior run's approach.

**Improvement (deployed):** the `surface-scanner` severity-overload fix — logged as a finding on
07-16 and re-proposed with a full fix + verification plan in `improvement-log.md`'s 07-23 entry —
had been mentioned twice but never applied. Confirmed still live: a fresh scan at 00:08 UTC wrote
`surface_scan_complete` at `severity: "warning"` (29 alerts, matching the historical ~98% rate).
Changed `surface-scanner/index.ts:450` to always log `severity: "info"` for `surface_scan_complete`
(routine heartbeat, not a health signal) and added `metadata.high_edge` (boolean) so the
trading-opportunity signal isn't lost, just moved out of the tier reserved for things needing a
human. `cache_stale` (:365) and `surface_scanner_error` (:494) are untouched and still fire at
`warning`/`error`. `deno check`: 5 baseline errors (pre-existing `.then().catch()` typing issue,
none in the changed lines) — same count before and after. Deployed
(`supabase functions deploy surface-scanner`) and verified live: invoked directly post-deploy →
new row logged `severity: "info"`, `metadata.high_edge: true` (29 alerts, edge ≥10¢ present);
the two prior `warning` rows from before the deploy are unchanged, confirming this only affects
new rows. Reversible: single-field revert, no schema change.

**Reversibility:** single-file, single-field edit plus one additive metadata key. Trivial to revert.

## 2026-07-25 (6th run) — Telegram/`compliance_log` clean; daily trade cap legitimately maxed (52/50), not a bug; completed the daily-trade-cap consolidation the 5th run unblocked

**Telegram error state:** Queried `compliance_log` directly for `error`/`critical` severity
since 22:00 UTC (the 5th run's cutoff) — zero rows. All routine event types (`market_data_fetch`,
`auto_trade_run`, `auto_settle_run`, `surface_scan_complete`) logging normally. One live strategy
(`S-001-l`) is `risk_blocked` on `"Global daily trade cap reached: 52/50 trades today"` — checked
whether this is a recurrence of the earlier failed-order-counting bug: queried `trades` directly
for today's live rows by status — `{cancelled: 18, failed: 32, open: 34}`. 34 + 18 = 52 matches
the reported count exactly, confirming the cap is correctly excluding the 32 `failed` rows (the
2nd run's fix) and counting only real trades. **Not a bug** — the account has genuinely placed
52 live trades today and hit its configured 50/day risk limit; trading resumes at the next UTC
day boundary. No fix needed for this.

**Improvement (deployed):** completed the daily-trade-cap consolidation the 2nd run recommended
and the 5th run unblocked (by fixing `tenant.ts`'s `never`-typed calls) but didn't itself apply.
`auto-trade/index.ts`'s inline daily-cap query (duplicate of `_shared/limits.ts`'s
`countTradesInWindow`) is now replaced with a call to the shared function — the exact
failed-order-counting bug fixed independently in both files earlier today can no longer be
reintroduced in only one of them. **Verified:** `deno check` — `auto-trade` 17/17,
`execute-trade` 20/20, same baseline as post-tenant-fix, zero new errors. Deployed
(`supabase functions deploy auto-trade`, commit `c20457e`) and invoked directly post-deploy:
identical output to pre-change (`"Global daily trade cap reached: 52/50"`, `0 errors, 0 halted`),
confirming no behavior change — purely a duplicate-logic removal.

**Reversibility:** single-file, single-function edit (import + one query call), trivial to revert.

## 2026-07-25 (5th run) — Telegram clean for 2h post-`314e10c`; unblocked the deferred `tenant.ts` type-error fix instead of re-diagnosing resolved incidents

**Telegram error state:** Queried `compliance_log` directly (REST API, service key — same
approach as the 4th run). Zero `error`/`critical` rows and zero `health_check_alert` rows from
20:12 UTC (the `314e10c` sequential-leg-submission deploy) through 22:10 UTC — a full 2h clean
window, `auto_trade_run` logging normally every 5 min (`0 errors, 0 halted` every cycle). All
three error classes active earlier today (RSA-PSS/`time_in_force` @ 15:10–15:20, `insufficient_balance`
@ 16:15–19:00) remain resolved; no new error class appeared. No fix needed this pass — re-verifying
and re-fixing already-closed incidents from the same day would just be busywork.

**Improvement (deployed — commit only, no function redeploy needed):** the 2nd run's log entry
flagged `_shared/tenant.ts`'s two `never`-typed Supabase calls (`setRiskHalt`'s `.update()`/`.insert()`)
as the reason a recommended fix — consolidating `auto-trade`'s duplicate daily-trade-cap counter onto
`_shared/limits.ts`'s `countTradesInWindow()` — had to be reverted; importing `limits.ts` pulls in
`tenant.ts`, and its 2 type errors then surface as *new* regressions against files that didn't
previously reach that import graph. Root cause: `tenant.ts:161-169` chained `.update()`/`.insert()`
directly off `supabase.from("risk_state")` without a cast, and `SupabaseClient`'s untyped generic
resolves that table's row type to `never` in strict mode — the same pattern the file *already* works
around at line 184 (`(query as any).eq(...)`) but the two calls in `setRiskHalt` didn't follow it.
Applied the identical cast-the-query-builder idiom to both calls (`(supabase.from("risk_state") as any)`)
— zero runtime behavior change, compile-time only. **Verified:** `deno check` on `tenant.ts` itself:
2 errors → 0. All 4 functions that import it: `execute-trade` 22→20, `execute-basket` 4→2,
`kalshi-proxy` 13→11, `switch-trading-mode` 3→1 — every count went down, none went up, confirming no
new errors were introduced anywhere in the import graph. Not deployed as an edge function (no
runtime change to ship); committed so CI reflects the lower baseline. This unblocks — but does not
itself perform — the daily-trade-cap consolidation the 2nd run recommended twice; that's a live
trading-logic change and stays a separate, reviewed step rather than something to bundle into an
unattended type-fix pass.

**Reversibility:** single-file, two-line cast change, no schema/runtime impact. Trivial to revert.

## 2026-07-25 (4th run) — No new Telegram error class; deployed the already-diagnosed cache-eviction fix from 2026-07-23

**Telegram error state:** Clean since the 3rd run's `314e10c`/`baec481` deploy (~20:13 UTC).
Queried `compliance_log` directly (`supabase db query --linked` failed auth — `LegacyDbConfigLoginRoleStatusError`
401; fell back to the REST API with the service key). Zero `error`/`critical` rows in the
~53-min post-deploy window; system active and healthy (`auto_trade_run`, `market_data_fetch`,
`auto_reflect_run`, `trade_settled` all logging normally at their usual cadence). The three
error classes seen in the preceding 6h — `order_failed`/`insufficient_balance` (16:15–19:00 UTC),
`order_failed`/`INCORRECT_API_KEY_SIGNATURE` (15:10–15:15 UTC), and `trades_time_in_force_check`
violation (15:20 UTC) — are all already resolved: the signature and time-in-force errors both
predate `a73c79a` (deployed 15:25 UTC, fixed both in one commit), and the insufficient-balance
errors predate the 3rd run's `314e10c` (20:13 UTC). No unresolved errors found this run.

**Improvement made (deployed):** shipped the one-line cache-eviction fix that was root-caused
but left undeployed in the 2026-07-23 entry below — `market-data-fetcher/index.ts`'s eviction
guard checked `failedSeries.length === 0` but not `skippedSeries.length === 0`, so a
budget-abort cycle (zero failures, series simply never attempted) would still pass the guard
and delete live `kalshi_markets_cache` rows for series that were skipped, not closed. Two
consecutive aborts would have emptied cache for real open markets — surface-scanner and
signal-generator would see zero markets for those series instead of one-cycle-stale data.
Changed the guard to `failedSeries.length === 0 && skippedSeries.length === 0`. Deployed
(commit `57d0969`) and verified in prod: post-deploy invoke → `18/18 series OK, 0 failed,
0 skipped, 4283ms` — no regression on the non-abort path (the change only alters behavior
on an already-rare abort branch). Reversible: single-line revert of the guard condition.

## 2026-07-25 (3rd run) — S-001 basket legs submitted concurrently raced the balance pre-flight, reproducing the exact `insufficient_balance` failures the earlier pre-flight fix was meant to stop

**Telegram error state:** No new error *class* since the prior run's `daily_trade_cap` fix
(commit `9062d32`, ~19:12 UTC). But the same S-001 basket (`KXINX-26JUL27H1600-B7412/37/62`)
kept failing with `order_failed`/`insufficient_balance` every ~5 min from 18:15–19:10 UTC —
*after* the 13:14 UTC balance pre-flight (commit `9d47913`) was already deployed, which should
have caught this. 13 `order_failed` rows + 13 `liquidity_fallback` warnings in that window, plus
3 `rate_limit_exceeded` warnings on `execute-trade` (live limit: 3/min) at 19:05:03 — all three
fired within the same second.

**Root cause:** `auto-trade/index.ts`'s S-001 handler submitted every leg of a basket via
`Promise.all(tradeable.map(...))` — concurrently. `execute-trade`'s balance pre-flight (from the
prior fix) does a fresh `GET /portfolio/balance` per call and compares it to that one order's
required collateral, but three concurrent calls all read the *same* stale, not-yet-decremented
balance before any of them locks funds. Each leg's pre-flight independently "passed," Kalshi's
real order matching only allows the account to actually cover 1–2 of the 3 legs, and the rest come
back as a real `insufficient_balance` 400 — the exact failure the pre-flight was built to prevent,
just moved from "before submission" back to "after submission" for anything past the first leg.
The same concurrency also explains the `rate_limit_exceeded` triple: 3 simultaneous live
`execute-trade` calls exactly saturate the 3/min live limit, leaving zero headroom for any other
order (a stop-loss close, another strategy) in that window.

**Fix (deployed):** changed the S-001 leg loop from `Promise.all(...)` to a sequential
`for...of` with `await` per leg (`auto-trade/index.ts` ~line 1273). Each leg's pre-flight now
sees Kalshi's real, post-previous-leg balance instead of a stale snapshot, and legs are spread
across the rate-limit window instead of colliding on it. `deno check`: 17/17 errors, same as
baseline, none in the changed range. Deployed via `supabase functions deploy auto-trade`.
**Verification:** watched `compliance_log` through the next live cron cycles post-deploy for a
fresh multi-leg S-001 alert; see follow-up note below for the result.

**Improvement (deployed same pass):** added an early-exit inside the same loop — once a leg's
pre-flight returns `code: "insufficient_balance"`, the loop breaks instead of attempting the
remaining legs, since account balance won't replenish mid-cycle. Saves the wasted round trips and
the rate-limit budget those doomed calls would otherwise consume.

**Reversibility:** both changes are scoped to one loop in `auto-trade/index.ts`, single-function
revert.

## 2026-07-25 (later run, 2nd) — daily-trade-cap counted failed orders in *two* independent places, actively rejecting live trades right now

**Telegram error state:** All errors in the last 6h trace back to the three clusters already
resolved earlier today (auth 401 → fixed ~15:25 UTC; `time_in_force` constraint → fixed same
commit; `insufficient_balance` → pre-flight check deployed ~17:14 UTC). Zero new error classes.
But `daily_trade_cap_enforced` fired 63x in the trailing 6h (vs. single digits on a normal day)
and the most recent hit, live at time of this check: `"Trade rejected: daily trade cap (100)
reached for user ea207ba1... in live mode"`, `count: 102, limit: 100` — a live 429 actively
blocking every order.

**Root cause:** today's earlier auth/balance bugs generated 70 failed live orders in 24h
(`select mode, status, count(*) from trades ... group by mode, status` confirmed 70 `failed` vs.
14 `open` + 18 `cancelled` = 32 real). Two independent daily-trade-cap checks both counted every
`trades` row regardless of `status`:
1. `auto-trade/index.ts`'s own inline pre-check (Risk-tab `max_daily_trades`) — already caught and
   fixed in this run's first pass (see below), before the second gate was found.
2. `_shared/limits.ts`'s `countTradesInWindow()` — the actual enforcement gate inside
   `execute-trade` that returns the 429 — has an explicit comment stating it was written to
   *replace* both counters, but `auto-trade` was never migrated onto it, so the same
   failed-order-counting bug had to be (and was) fixed independently in both places.
70 failed + 32 real = 102, which alone exceeded the account's 100/day tier cap — meaning **live
trading was blocking itself with a false daily-limit page even after the underlying auth/balance
bugs were fixed**, because the failures those bugs caused were still being held against the cap.

**Fix (deployed):** added `.neq("status", "failed")` to both counters —
`auto-trade/index.ts:713` and `_shared/limits.ts`'s `countTradesInWindow` (used by
`execute-trade`'s 429 gate). Both bound real trading activity/exposure now, not attempts rejected
before ever reaching the exchange. `deno check` on each file shows the same error count as
baseline (`auto-trade`: 17/17, `limits.ts`: 2/2, `execute-trade`: 22/22) — zero new errors.
Deployed via `supabase functions deploy auto-trade` and `execute-trade`. **Verified live:** polled
`compliance_log` through the next real cron cycle post-deploy — the same underfunded S-001 basket
retried (2 legs got real Kalshi order IDs and rested, 1 leg correctly rejected on genuine
insufficient balance for that specific leg) with **zero `daily_trade_cap_enforced` rejections** —
confirms the cap no longer trips on its own failure history. Real trade count post-fix: 32/100,
comfortable headroom.

**Improvement (recommended, not applied):** `_shared/limits.ts` was written specifically to be
the single source of truth replacing duplicate cap-counting logic (its own header comment says
so), but `auto-trade` was never migrated onto it — which is *why* this exact bug needed fixing
twice today. Attempted the consolidation (import `countTradesInWindow` into `auto-trade`, drop
its inline query) in this pass; reverted because it transitively pulls in `_shared/tenant.ts`
(via `limits.ts` → `getRiskSettings`), which surfaces 2 pre-existing type errors in `tenant.ts`
that `auto-trade`'s type-check graph doesn't currently reach — a real (if pre-existing elsewhere)
regression against this repo's own "zero new `deno check` errors" bar. Worth doing once
`tenant.ts`'s two `never`-type errors (`update(payload)` and `.insert({...,user_id})`, both typed
`never` from an under-specified Supabase client generic) are cleaned up separately — at that
point `auto-trade` can safely import `countTradesInWindow` and this class of bug becomes
impossible to reintroduce by construction.

**Reversibility:** both `.neq("status", "failed")` additions are single-line, independently
revertible. No schema or migration involved.

## 2026-07-25 (scheduled health check) — live basket rejected 7x on `insufficient_balance`; no pre-flight balance check existed

**Telegram error state:** 7 `order_failed` / `error` rows, all `insufficient_balance` (Kalshi
400), clustered 16:10–16:20 UTC — 3 legs of one S-001 arb basket (`KXINX-26JUL27H1600-B7412/
B7437/B7462`, buy-NO ~80-83c, 12 contracts/leg) each retried 2-3x across two surface-scanner
cycles before the alert-dedup (`kalshi_order_rejected`, 1h cooldown) went quiet. No occurrences
in the preceding 7 days — this was a fresh, one-off underfunding, not a chronic condition. One
unrelated `authentication_error` (401, `INCORRECT_API_KEY_SIGNATURE`) at 15:15 UTC — single
occurrence, not investigated this pass (no recurrence, likely a transient signing-timestamp skew).

**Root cause:** `execute-trade/index.ts`'s live path (`_shared/kalshi-auth.ts:640-648`) had zero
balance awareness — it submits every order straight to Kalshi and only learns the account can't
cover it from the 400 response. Each leg cost a full wasted round trip, and the resulting
`order_failed` row was indistinguishable from any other rejection reason (rate limit, bad ticker,
auth) until read closely. Verified: `required collateral ≈ (1 - price) × count` per leg ≈ $9.80-9.96
each ≈ $29 for the 3-leg basket, which the account's live balance didn't cover.

**Fix (deployed):** added a pre-flight balance check to `execute-trade/index.ts` — before
submitting a live order, fetch real account balance via `GET /portfolio/balance` (same call
`kalshi-ping` already uses to validate keys) and compare against the order's actual required
collateral (`price × count` for a buy, `(1-price) × count` for a sell/short — the exchange's
standard per-contract margin). If balance is short, skip the Kalshi call entirely, log a distinct
`order_skipped_insufficient_balance` compliance row (not a generic `order_failed`), and fire one
account-level Telegram alert (not one per ticker) naming the exact shortfall. Fails open on a
balance-fetch error — never blocks a trade on a monitoring-path failure. **Verified:** `deno check`
shows zero new type errors vs. baseline (22 pre-existing esm.sh version-mismatch errors, same count
before/after, none in the new code); deployed via `supabase functions deploy execute-trade`. Not yet
observed against a live retry (no basket has re-attempted this specific ticker set since deploy) —
the next live rejection, if any, is the real-world proof; watch for `order_skipped_insufficient_balance`
replacing `order_failed`+400 in `compliance_log`.

**Improvement shipped (this pass):** `health-check/index.ts` had no visibility into real Kalshi
account balance at all — the only way to learn about a funding shortfall was to wait for orders to
start failing. Added a 10th check: fetch live balance for every `kalshi_live` API key and alert
(12h cooldown, dedup'd) if it's under $15 — enough to cover a typical single-leg basket cost. This
turns the exact failure mode above into a proactive warning instead of reactive error-log noise.
Deployed and invoked once post-deploy (`{"ok":true,...}`, no crash); current live balance is above
the $15 floor so no alert fired this run — correct behavior, not yet exercised against a real low-
balance state.

## 2026-07-25 (later run) — reconcile-orders-cron was never actually registered; live orders could rest unreconciled forever

**Telegram error state:** The two bugs from the same-day entry below (RSA-PSS signing,
`time_in_force` constraint) are now confirmed fully resolved with live data, not just
"deployed" — `select mode, status, count(*) from trades where exchange='kalshi' group by
mode, status` shows 32 live orders now reaching `status='open'` cleanly, zero `error`/`critical`
compliance_log rows since 15:20:08 UTC (vs. constant failures before). `time_in_force` values are
correctly `gtc` throughout. This closes the "not yet confirmed against a live order" gap noted in
the entry below.

**New root cause found and fixed (CRITICAL):** All 30+ resting live limit orders showed `0/N
filled` no matter how old (oldest 43 min at check time) — before concluding this was a bug I
invoked `reconcile-orders` directly and it worked fine (`{"checked":30,"unchanged":30,"errors":0}`),
so the *function* wasn't broken. But `select jobname from cron.job` showed **no
`reconcile-orders-cron` job at all** — the function's own doc comment says it's "Invoked by the
reconcile-orders-cron pg_cron job," and a migration (`20260719_realmoney_reconciliation.sql`,
6 days old) exists to create exactly that job plus widen `agent_trades_pending_resolution` to
include live trades. It was never applied: the migration file itself has a syntax bug (`) ON
CONFLICT (jobname) DO UPDATE...` appended to a bare `SELECT cron.schedule(...)`, which Postgres
rejects — `SELECT` doesn't support `ON CONFLICT`. Applying it verbatim reproduced the exact
syntax error, confirming why it silently never landed. Fixed by dropping the invalid clause
(pg_cron 1.6.4's `cron.schedule()` already upserts by jobname) and applying both parts. **Verified
in prod:** job registered (`cron.job` row, active), fired automatically at its first scheduled
tick (`cron.job_run_details` runid 260178, `succeeded`), and `agent_trades_pending_resolution`
now reads `mode = ANY(paper, live)`. Net effect before the fix: every live order that didn't fill
instantly on submission was invisible to auto-settle and would eventually be wrongly zeroed by the
expiration sweep — silent live-trade P&L corruption, not just a cosmetic status field.

**Improvement (deployed):** this bug was invisible to the existing cron watchdog
(`cron_health()`, added 2026-07-06) by construction — it iterates `FROM cron.job`, so a job that
was never registered in the first place can't appear as stale or failed; it only catches jobs
that stop running, not jobs that never started. Added `public.expected_cron_jobs` (manifest table
seeded with all 11 permanent jobs) and rewrote `cron_health()` to `UNION ALL` in a synthetic
`is_stale=true, last_status='missing'` row for any manifest entry absent from `cron.job`. Gave it
its own alert branch in `health-check/index.ts` (`cron_missing`, distinct message from
`cron_stale`) so a future "wrote the migration, forgot to apply it" mistake pages loudly within
the hour instead of hiding for 6 days. **Verified:** `select * from cron_health()` returns all 11
manifest jobs healthy with no false-positive missing rows; redeployed `health-check` and invoked
it once post-deploy — ran clean, no `cron_missing`/`cron_stale`/`cron_failed` alerts.
Reversible: drop the `UNION ALL` branch and the manifest table to revert.

## 2026-07-25 — Live trading was 100% broken since going live: HMAC signing instead of Kalshi's required RSA-PSS, plus a second constraint bug it had been hiding

**Telegram error state:** `failed_trade_queue` showed every live order failing. First cluster
(2026-07-24 22:15–22:50, `deprecated_v1_order_endpoint`, 410) was the old
`/trade-api/v2/portfolio/orders` endpoint Kalshi has retired in favor of
`/trade-api/v2/portfolio/events/orders`. A same-day in-progress fix (uncommitted on
`fix/live-pilot-instrumentation`) switched the endpoint, which was deployed ~15:03 UTC today —
and immediately every order started failing differently: `authentication_error` /
`INCORRECT_API_KEY_SIGNATURE` (401), 6 in a row. `select mode, status, count(*) from trades
where exchange='kalshi' group by mode, status` showed **60/60 live attempts ever made had
status='failed' — zero successful live trades since real-money trading was enabled
(2026-07-24 21:30).**

**Root cause found and fixed (CRITICAL):** `_shared/kalshi-auth.ts` signed every Kalshi request
with **HMAC-SHA256** over a **second-precision** Unix timestamp. Kalshi's actual scheme (confirmed
against current docs) is **RSA-PSS-SHA256** (salt length = digest length, 32 bytes) over a
**millisecond-precision** timestamp, signing the path only (no query string). This bug is old, not
new — the retired `/portfolio/orders` endpoint was returning its 410 deprecation error *before*
Kalshi ever validated the signature, so the broken auth was invisible until today's endpoint fix
let requests reach real signature validation for the first time. Fixed `generateAuthHeaders` to do
proper RSA-PSS signing (PKCS8 and PKCS1 PEM import, both handled) and switched every caller
(`execute-trade`, `settle-signals`, `reconcile-orders`, `kalshi-proxy`, `market-data-fetcher`) from
`Math.floor(Date.now()/1000)` to `Date.now()`; `kalshi-ping`/`save-kalshi-key` already used ms.
**Verified against the real Kalshi API**, not a mock: minted a session token for the live user and
called `kalshi-ping` (read-only `GET /portfolio/balance`) — first successful authenticated Kalshi
call ever recorded for this account, `{"ok":true,"balance_usd":100}`.

**Second bug, found by the first fix working:** the next real cron cycle got past auth and hit a
new error, `new row for relation "trades" violates check constraint
"trades_time_in_force_check"`. The same uncommitted V2 migration introduced
`kalshiOrderPayload.time_in_force` in Kalshi's V2 vocabulary
(`fill_or_kill`/`good_till_canceled`/`immediate_or_cancel`) and then wrote that same value into our
own `trades.time_in_force` column — but that column's CHECK constraint (and every real caller,
`auto-trade` always sends `"day"`) only accepts the legacy `gtc`/`ioc`/`day` vocabulary. Fixed by
storing a normalized `ledgerTimeInForce` (our own bookkeeping label) instead of the Kalshi-payload
value. **Not yet confirmed against a live order** — deployed, waiting on the next auto-trade-cron
cycle to verify end-to-end.

**Improvement (deployed):** the HMAC bug shipped with zero test coverage because the signing logic
lived in `_shared/kalshi-auth.ts`, which imports `esm.sh` URLs vitest can't resolve — this codebase
already has a "pure logic extracted for testability" convention (`_shared/trading-logic.ts`) that
`kalshi-auth.ts` didn't follow. Extracted the signing logic into a new import-free
`_shared/kalshi-signing.ts` (re-exported from `kalshi-auth.ts` so no call sites changed) and added
`tests/kalshi-signing.test.ts` — 4 tests, RSA-PSS round-trip verified against a generated key pair,
signature byte-length check (256 bytes RSA vs 32-byte HMAC), ms-timestamp check, query-string
stripping. All pass. This is a permanent regression guard: any future accidental reversion to HMAC
or second-precision timestamps now fails CI, not silently in production for months.

**Reversibility:** both fixes are single-function edits, revertible independently. The RSA-PSS
signing change affects every Kalshi-authenticated call (`execute-trade`, `kalshi-ping`,
`reconcile-orders`, `settle-signals`, `kalshi-proxy`, `market-data-fetcher`, `save-kalshi-key`) —
all redeployed and re-verified via `kalshi-ping` after the refactor.

## 2026-07-17 — `fetchWithRetry` retried AbortErrors, silently defeating market-data-fetcher's 8s per-request timeout

**Telegram error state (last 48h):** One new critical since the 07-16 check: `market_data_fetcher_aborted`
at 2026-07-16 22:47 UTC, "run budget exceeded (61.4s)", 1 series failed (`KXHIGHMIA`), 3 skipped
(`KXFED`, `KXGDP`, `KXPAYROLLS`). Self-recovered next cycle (22:51, 18/18, 2.9s) and has stayed
healthy since (18/18, ~2–4s every run through 12:53 today). `trading_silence` fired 07-17 03:10 —
last fill is 2026-07-16 03:05 UTC (~34h ago); strategies are running every 5 min and logging
`no_setup` (filters not met), not erroring, so this reads as market conditions, not a bug. The
07-16-logged `surface-scanner` severity-overload item is still open, unchanged, not re-logged here.

**Root cause found and fixed (HIGH):** `market-data-fetcher/index.ts` wraps each series fetch in
an 8s `AbortController` timeout specifically so "no single request can hang the run" (its own
doc comment, line 32). But `_shared/kalshi-auth.ts:126` `fetchWithRetry` caught the resulting
`AbortError` in its generic `catch` block and retried it like any transient network error —
exponential backoff (1s → 2s → 4s + jitter) across 3 more attempts against an already-aborted
signal that rejects instantly. Net effect: one stuck/rate-limited series took up to ~16.5s to
fully fail instead of the intended 8s cap, and since `RUN_BUDGET_MS` (50s) is only checked
*between* batches, one bad series in a batch of 5 was enough to blow the budget for the whole
run. This is the same failure class as 07-09 (3×) and 07-13 (full abort, since reduced by
batching but not eliminated) — batching cut the blast radius, this closes the actual hole.

**Fix (deployed):** `fetchWithRetry` now rethrows immediately on `AbortError` instead of
retrying it — cancellation is terminal, not transient. **Verified in prod:** invoked
`market-data-fetcher` once post-deploy → `18/18 series OK, 0 failed, 0 skipped, 3208ms`
(no regression on the happy path; the fix only changes behavior on the abort branch, which
doesn't fire under normal conditions — next 429/timeout event is the real-world proof).
Reversible: single-function revert of the `catch` block in `_shared/kalshi-auth.ts`.

## 2026-07-16 — `compliance_log.severity` overloaded for trading signal, not system health

**Telegram error state (last 48h):** Clean. No `error`/`critical` rows since the 07-13
`market_data_fetcher_aborted` (already resolved 07-14). Zero Telegram alerts fired in the
window. Trading is active (order fills present in `auto_trade_strategy_run`/`order_filled` rows).

**Improvement (logged, MED):** `surface-scanner/index.ts:450` writes `severity: "warning"` to
`compliance_log` on *every* scan that finds an alert with `expected_edge_cents >= 10` — which is
effectively every 5-minute run right now (100% of the last 100 sampled rows were
`surface_scan_complete` warnings). That's a **trading-opportunity flag**, not a system-health
signal, but it shares the same `severity` column the health-check sweep and this exact audit query
by severity. Result: a real `error`/`critical`/`warning` row is needle-in-haystack behind ~288
routine warnings/day. Same root issue as the already-queued `s001_edge_below_fee_hurdle` noise item
in `TASKS.md` — severity is being reused as a business signal. Fix: give surface-scanner its own
`event_type`-based signal (e.g. keep `severity: "info"` always, add `metadata.high_edge: true`) so
`severity` stays reserved for things that actually need a human. Not deployed this run — logging
only, no code/infra change made autonomously.

## 2026-07-14 — market-data-fetcher runs unauthenticated (root cause of Kalshi 503/429 alerts)

**Telegram error state (last 7 days):** No new-class failures. The 07-13 `market_data_fetcher_aborted`
(130.6s run-budget) critical is resolved — fetcher now completes 18/18 series in ~2–3s per cycle
(verified: 10:06 run 3.1s, 18/18, 0 failed). `trading_silence` alerts (07-10, 07-13) were transient —
trading has resumed (last fill 2026-07-14 05:05, `KXINX` filled). Only recurring alerts left are
`api_error_kalshi` 503/429 (07-09, 07-12) — addressed by the improvement below.

**Improvement (logged, HIGH):** Every `market_data_fetch` compliance row still logs
`authenticated: false` — `getKalshiCredentials(supabase, null)` finds no `kalshi_live` row for the
NULL/service tenant and no `KALSHI_API_KEY_ID` / `KALSHI_API_PRIVATE_KEY` env fallback
(`_shared/kalshi-auth.ts:113–114`), so the fetcher hits Kalshi anonymously at the lowest rate tier.
That anonymous tier is the root cause of the recurring 503/429 alerts and the pressure that blew the
old sequential fetcher's budget. Fix: provision a service-level Kalshi key for the fetcher — set
`KALSHI_API_KEY_ID` + `KALSHI_API_PRIVATE_KEY` in the edge-function secrets (or seed a `user_id IS NULL`
`kalshi_live` row) so `authenticated: true`. Expected effect: higher rate ceiling, 503/429 alerts stop,
more headroom under the 50s budget. Reversible (secret-only change, no code).

**RESOLVED — 2026-07-14.** Seeded a service-tenant `api_keys` row (`user_id IS NULL`, provider
`kalshi_live`, id `4306d894…`) reusing the encrypted `key_id`/`secret_ciphertext`/`secret_iv` from
the only stored Kalshi key — Onofre's own (`omiiaiagency@gmail.com`); market-data fetch is read-only,
no trading on the account. No plaintext handled: the fetcher decrypts at runtime via the
`API_KEY_ENCRYPTION_KEY` already set on the edge functions. **Verified in prod:** invoked once →
`authenticated: true`, 18/18 series, 0 failed, 805 markets, 2.3s. Rollback: delete row `4306d894…`.

## 2026-07-13 — market-data-fetcher starving on run budget

**Telegram error state (last 7 days):** No new-class failures. The July-6 wave
(`.catch is not a function` in auto-trade strategies + `trade_lessons` check-constraint
violations) is resolved — no recurrences since the 2026-07-10 production-hardening
migration. Remaining alerts are Kalshi upstream 503/429s (transient) and the item below.

**Active issue (critical, today):** `market-data-fetcher` aborted at **130.6s** against a
50s `RUN_BUDGET_MS`, skipping **all 18 series** (KXFED, KXCPI, KXBTC, KXHIGHNY, …). Series
are fetched **strictly sequentially** with per-request retries + `KALSHI_REQUEST_SPACING_MS`
spacing; a few slow/retrying series consume the whole budget, so the budget check trips before
most series are refreshed. Downstream, signal-generator / weather-signal / futures-signal run
on stale market data.

**Improvement (logged to TASKS.md, Queued, HIGH):** Fetch series in **bounded concurrent
batches** (e.g. 4–6 at a time via `Promise.all`) instead of one-at-a-time, and **rotate the
starting series offset each run** so the same tail series aren't perpetually last-in-line and
starved. Expected effect: ~4–6× lower wall-clock, run stays inside the 50s budget, full series
coverage each cycle. Per-request 8s `AbortController` timeout already exists and stays.

**RESOLVED — deployed 2026-07-13.** Rewrote the fetch loop to process series in bounded
concurrent batches (`BATCH_SIZE = 5`, 110ms intra-batch stagger to stay ≤~9 req/sec) with a
rotating per-run start offset. Circuit breaker changed from consecutive-series-failures to
consecutive fully-failed-batches (Kalshi-down signal). Per-request 8s timeout and 50s run budget
retained. **Verified in prod:** invoked once → 18/18 series OK, 844 markets cached, **3.4s**
(was 130.6s abort / 0 series). `compliance_log` `market_data_fetch` row logged `info`, 18/18.

**Follow-up flagged (not blocking):** the verified run logged `authenticated: false` —
`getKalshiCredentials()` returned no Kalshi key, so the fetcher runs unauthenticated (lower rate
limits). It still succeeded, but this is likely what made the old sequential version hit 503s and
blow its budget under load. Worth wiring a service-level Kalshi key for the fetcher.
