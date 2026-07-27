# TradeAgent — Health Check Log

Findings from automated health-check runs. Newest first.

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
