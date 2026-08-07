/**
 * Tenant scoping for agent_memory reads.
 *
 * Edge functions authenticate with the service-role key, so every RLS policy on
 * agent_memory is bypassed — isolation is whatever the query text says and nothing
 * more (the same warning `_shared/tenant.ts` carries for trades and risk state).
 * Several memory reads relied on `strategy_id` to isolate tenants incidentally,
 * which holds only while every strategy is single-owner. It does not hold for the
 * shared system strategies (`strategies.user_id IS NULL`), where auto-reflect
 * writes one memory row per user under the same `strategy_id`: a top-5-by-
 * confidence read then pulls whichever users' lessons happened to score highest
 * and feeds them into another user's qualify prompt.
 *
 * This is the read-side counterpart to `_shared/lesson-dedupe.ts` and exists for
 * the same reason — the defect is an *omitted* filter, which no test of the
 * surrounding function can catch. Testing the filter set directly can.
 */

/** A UUID is the only shape auth.users.id ever takes; anything else is rejected. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemoryScope {
  /**
   * Owner whose memories this read is allowed to see. `null` means there is no
   * owner in context (a system/legacy strategy run), which restricts the read to
   * platform rows only — never "all rows".
   */
  userId: string | null;
  /**
   * Whether platform-global rows (`user_id IS NULL`) are visible alongside the
   * owner's own. Defaults to true: shared platform lessons are the product's
   * stated moat. Set false for reads that must return only what the user owns.
   */
  includePlatform?: boolean;
}

/**
 * Applies tenant scoping to a PostgREST query over agent_memory.
 *
 * `userId` is interpolated into a PostgREST `or=` filter string, which is a
 * parser context — a value containing `,` or `)` would rewrite the filter tree.
 * Callers pass values read from our own tables, but validating here means a
 * future caller cannot turn a bad id into a silent scope escape.
 *
 * @throws if `userId` is a non-null value that is not a UUID.
 */
export function applyMemoryTenantFilter<T>(query: T, scope: MemoryScope): T {
  const { userId, includePlatform = true } = scope;
  // deno-lint-ignore no-explicit-any
  const q = query as any;

  if (userId === null || userId === undefined) {
    return q.is("user_id", null) as T;
  }
  if (!UUID_RE.test(userId)) {
    throw new Error(
      `applyMemoryTenantFilter: refusing to scope agent_memory to a non-UUID user_id (${
        JSON.stringify(userId)
      })`,
    );
  }
  return (
    includePlatform
      ? q.or(`user_id.is.null,user_id.eq.${userId}`)
      : q.eq("user_id", userId)
  ) as T;
}
