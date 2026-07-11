# Case Study: The `was_acted_on` Signal Flag That Was Never Set

**Date discovered:** 2026-05-23  
**Severity:** High (ongoing API cost waste, compliance log pollution)  
**Status:** Fixed in commit after discovery  
**System:** TradeAgent — Supabase Edge Functions, auto-trade cron engine

---

## Summary

A boolean column `was_acted_on` was added to the `signals` table to prevent a signal from being acted on more than once. The column was never written to. As a result, every auto-trade cron run (every 30 seconds) read and submitted the same signal rows to the LLM qualifier, generating up to **1,440 redundant LLM API calls per signal per 12-hour window** — with zero additional trading value.

---

## The Failure

### What was built

The `signals` table was designed with this column (migration `20260406_signal_surface_tables.sql`):

```sql
was_acted_on BOOLEAN DEFAULT FALSE
```

The intent was clear: once auto-trade places a trade from a signal, mark it consumed so the next cron run skips it.

### What was missing

No code in the codebase ever executed:

```sql
UPDATE signals SET was_acted_on = true WHERE id = <signal_id>
```

A search for `was_acted_on` in `supabase/functions/auto-trade/index.ts` returned zero results on the write path. The column existed only as a filter in reads that was also never used — signal queries did not include `WHERE was_acted_on = false`.

### Why it wasn't caught

1. **No test for signal consumption lifecycle.** Tests covered risk math, billing logic, and encryption — not the signal read/mark/skip loop.
2. **The blast radius was invisible at small scale.** With one user and one strategy running, the LLM calls happened 60x per signal window but all returned REJECT (because an open position already existed), so no bad trades were placed. The system "worked" — it just burned tokens silently.
3. **The partial mitigation masked it.** auto-trade has an open-position deduplication check: before placing a trade, it counts open positions for the ticker. If one already exists, it skips. This correctly prevented double-trading, but it consumed LLM API quota for every deferred attempt.

---

## Impact Quantification

With the system running as designed:

| Parameter | Value |
|---|---|
| auto-trade cron interval | 30 seconds |
| weather-signal refresh interval | 30 minutes |
| S-005 signal freshness window | 12 hours |
| S-002 signal freshness window | 2 hours |

**Redundant LLM calls per signal:**
- S-005 (weather): `(12 hrs × 3600 sec/hr) / 30 sec` = **1,440 calls per signal per window**
- S-002 (longshot): `(2 hrs × 3600 sec/hr) / 30 sec` = **240 calls per signal per window**

At signal-generator's 15-minute refresh (288 runs/day) and a Kalshi market universe of ~500 markets with signal scores above threshold, the total excess LLM calls scales rapidly with number of active users.

---

## Root Cause

**Missing write + missing read filter.** Two independent gaps, both needed to fix the issue:

1. **Write path (auto-trade):** After placing a trade from a signal, the code never called `UPDATE signals SET was_acted_on = true`.
2. **Read path (auto-trade):** The signal query never filtered on `was_acted_on = false`.

Either gap alone would cause the problem. Both need to be present for the fix to work correctly.

---

## The Fix

In `supabase/functions/auto-trade/index.ts`, two changes:

**1. Filter signal reads to unconsumed signals only:**
```typescript
// Before (every run reads all matching signals):
.eq("source", "weather_signal_s005")
.eq("signal_type", "buy")
.gte("created_at", cutoff)

// After (skip already-acted-on signals):
.eq("source", "weather_signal_s005")
.eq("signal_type", "buy")
.gte("created_at", cutoff)
.eq("was_acted_on", false)   // ← new
```

**2. Mark signal consumed after trade placement:**
```typescript
// After a successful trade insert:
await supabase
  .from("signals")
  .update({ was_acted_on: true, acted_on_at: new Date().toISOString() })
  .eq("id", sig.id)
  .eq("was_acted_on", false);  // conditional update acts as optimistic lock
```

The conditional `was_acted_on = false` in the UPDATE prevents a race condition where two concurrent auto-trade runs (before the distributed lock was enforced) could both claim the same signal.

---

## Why This Matters Beyond This System

This is an instance of a **semantic gap bug**: the database schema encoded the intended behavior correctly, but the application layer never implemented it. The column acted as documentation of intent rather than a working constraint.

Common in systems built fast:
- Schema designed by one person, handlers written later
- Column added "for future use" and never wired up
- Partial implementations that look complete from the outside because the blast-radius mitigation (open-position dedup) silently absorbed the failure

**Detection pattern:** Any boolean "flag" column with a DEFAULT of FALSE that has no UPDATE calls in the codebase should be treated as suspicious. The flag either needs to be wired or removed.

---

## Lessons

1. **Schema intent ≠ application behavior.** A well-named column documents what should happen, not what does happen. Treat them separately during audits.

2. **Cost failures are silent.** This bug never caused a bad trade. It would not have appeared in a win-rate analysis, a position audit, or any compliance alert. It was only findable by grepping for the column name across the codebase.

3. **Test the lifecycle, not just the happy path.** The existing tests verified: risk math, position sizing, circuit breaker tripping. None tested the signal → qualify → act → consume cycle end-to-end. That lifecycle is where this bug lived.

4. **Add a test for every flag.** For `was_acted_on` specifically, the regression test is: place one trade from a signal, assert `was_acted_on = true` on the signal row, run auto-trade again, assert no second LLM call was made for that signal.
