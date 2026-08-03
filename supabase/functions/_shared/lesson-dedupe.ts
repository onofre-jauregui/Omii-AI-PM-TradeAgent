/**
 * Lesson dedupe identity for auto-reflect's agent_memory writes.
 *
 * When auto-reflect turns a settled trade into a lesson it either bumps an existing
 * memory's confirmations/confidence or inserts a new row. Choosing the wrong merge
 * target is silent and corrupting: on 2026-08-01 a $22 live LOSS matched a memory
 * tagged "win" (confirmations 27) purely because they shared a ticker prefix, bumped
 * it to confidence 0.99, and wrote no loss lesson. The agent recorded a total loss as
 * further evidence of a winning rule.
 *
 * A memory is a legitimate merge target only when it shares the full identity of the
 * row that would otherwise be inserted: same owner, same strategy, same outcome, same
 * ticker family. Outcome is the axis that carries the safety property — a loss must
 * never be able to reinforce a win.
 */

export interface LessonIdentity {
  tickerBase: string;
  /** "win" | "loss" — must match the tag written onto the inserted row. */
  outcome: string;
  strategyId: string | null;
  userId: string | null;
}

/**
 * Tags a candidate memory must contain to be considered the same lesson.
 * Both are also written onto new rows, so a merge target is always reachable.
 */
export function lessonDedupeTags(identity: LessonIdentity): string[] {
  return [identity.tickerBase, identity.outcome];
}

/**
 * Applies the full dedupe identity to a PostgREST query builder.
 * Split out from auto-reflect so the filter set is directly testable — the original
 * bug was an omitted filter, which no test of the surrounding function would catch.
 */
export function applyLessonDedupeFilters<T>(
  query: T,
  identity: LessonIdentity,
  sinceIso: string,
): T {
  // deno-lint-ignore no-explicit-any
  let q = query as any;
  q = q
    .eq("is_active", true)
    .eq("memory_type", "lesson")
    .contains("tags", lessonDedupeTags(identity))
    .gte("created_at", sinceIso);
  q = identity.strategyId
    ? q.eq("strategy_id", identity.strategyId)
    : q.is("strategy_id", null);
  q = identity.userId ? q.eq("user_id", identity.userId) : q.is("user_id", null);
  return q as T;
}
