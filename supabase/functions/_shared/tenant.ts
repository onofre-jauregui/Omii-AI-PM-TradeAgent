import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Multi-tenancy helpers for edge functions.
 *
 * Edge functions run as service role and bypass RLS. To enforce per-tenant
 * isolation we must manually filter every query by user_id. This module
 * centralizes that pattern so individual functions can't forget.
 *
 * Resolution order for user_id, in order of precedence:
 *  1. Verified Supabase Auth JWT in the Authorization header
 *  2. Explicit user_id field in the request body (admin/service callers only)
 *  3. NULL — legacy single-tenant mode
 *
 * Until the auth gate is fully enforced in production, NULL is a valid
 * resolution and the queries fall back to the "default tenant" rows.
 */

export interface TenantContext {
  /** The resolved user_id, or null for the default/legacy tenant */
  userId: string | null;
  /** True if the user_id came from a verified JWT (vs request body or null) */
  authenticated: boolean;
}

/**
 * Resolve the tenant context from an incoming request. Verifies any JWT
 * present in the Authorization header against Supabase Auth.
 *
 * The supabase client passed in MUST be a service-role client so it can
 * call auth.getUser(jwt) for verification.
 */
export async function resolveTenant(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  /**
   * Optional pre-parsed request body. Pass this if you've already called
   * `await req.json()` in the handler, since the request body can only be
   * consumed once and `req.clone().json()` fails after the original is read.
   */
  parsedBody?: any
): Promise<TenantContext> {
  // 1. Try to extract and verify a JWT from the Authorization header
  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const jwt = authHeader.slice(7).trim();
    // Skip if this is just the service role key (used for cron / system calls)
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (jwt && jwt !== serviceKey) {
      try {
        const { data, error } = await supabase.auth.getUser(jwt);
        if (!error && data?.user?.id) {
          return { userId: data.user.id, authenticated: true };
        }
      } catch (e) {
        // Verification failed — fall through to other resolution paths
        console.warn("resolveTenant: jwt verification failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  // 2. Try an explicit user_id in the request body (service-role / admin path)
  // Prefer the pre-parsed body if the caller provided one. Fall back to
  // cloning and reading the request only if they didn't.
  if (parsedBody && typeof parsedBody.user_id === "string" && parsedBody.user_id.length > 0) {
    return { userId: parsedBody.user_id, authenticated: false };
  }
  if (!parsedBody && (req.method === "POST" || req.method === "PUT")) {
    try {
      const cloned = req.clone();
      const body = await cloned.json();
      if (body && typeof body.user_id === "string" && body.user_id.length > 0) {
        return { userId: body.user_id, authenticated: false };
      }
    } catch {
      // Body wasn't json or was empty — continue
    }
  }

  // 3. Legacy / default tenant
  return { userId: null, authenticated: false };
}

/**
 * Load the risk_settings row for a tenant, scoped to a trading mode.
 *
 * `risk_settings` holds one row per (user_id, mode) — enforced by the unique
 * index risk_settings_user_mode_idx. A query that filters by user_id alone
 * matches BOTH the paper and live rows, and `.maybeSingle()` then errors on
 * the multi-row result. That error must NOT be swallowed: doing so returns
 * null, which the live-trading gate reads as "no limits configured" and
 * rejects every live trade. So `mode` is required and the error is logged.
 *
 * Returns null only when no row genuinely exists for (user_id, mode), which
 * the caller should interpret as "no limits configured" (fail-closed for live).
 */
export async function getRiskSettings(
  supabase: ReturnType<typeof createClient>,
  userId: string | null,
  mode: "paper" | "live"
): Promise<any | null> {
  const query = supabase.from("risk_settings").select("*").eq("mode", mode);
  const { data, error } = userId
    ? await query.eq("user_id", userId).maybeSingle()
    : await query.is("user_id", null).maybeSingle();
  if (error) {
    // Loud, not silent: a swallowed error here is exactly what let the
    // live-trade-rejection bug hide. Log and fail closed (null).
    console.error(
      `getRiskSettings query failed (user_id=${userId ?? "null"}, mode=${mode}): ${error.message}`
    );
    return null;
  }
  return data || null;
}

/**
 * Load today's risk_state row for a tenant. Returns null if no row exists
 * (i.e. no trades yet today).
 */
export async function getRiskStateToday(
  supabase: ReturnType<typeof createClient>,
  userId: string | null
): Promise<any | null> {
  const today = new Date().toISOString().split("T")[0];
  const query = supabase.from("risk_state").select("*").eq("date", today);
  const { data } = userId
    ? await query.eq("user_id", userId).maybeSingle()
    : await query.is("user_id", null).maybeSingle();
  return data || null;
}

/**
 * Set (or clear) today's trading halt for a tenant. Writes risk_state scoped to
 * (user_id, date) — the trading path reads halt state per-user, so a row without
 * user_id is invisible to it (and rejected by RLS).
 *
 * Robust to migration apply-order: uses select-then-update/insert rather than an
 * onConflict upsert, so it works whether or not the UNIQUE(user_id, date)
 * constraint has been applied yet, and never depends on the old functional index.
 */
export async function setRiskHalt(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  halted: boolean,
  reason: string | null
): Promise<{ error: any }> {
  const today = new Date().toISOString().split("T")[0];
  const payload = {
    is_trading_halted: halted,
    halt_reason: halted ? reason : null,
    updated_at: new Date().toISOString(),
  };
  const { data: existing } = await supabase
    .from("risk_state")
    .select("id")
    .eq("user_id", userId)
    .eq("date", today)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from("risk_state")
      .update(payload)
      .eq("id", (existing as any).id);
    return { error };
  }
  const { error } = await supabase
    .from("risk_state")
    .insert({ ...payload, user_id: userId, date: today });
  return { error };
}

/**
 * Apply the user_id filter to a Supabase query builder. Use this in edge
 * functions to ensure every query is tenant-scoped.
 *
 * Example:
 *   const query = supabase.from("trades").select("*");
 *   const { data } = await applyTenantFilter(query, userId);
 */
export function applyTenantFilter<T>(query: T, userId: string | null): T {
  // The query builder is fluent — we cast through unknown for type-narrowing
  if (userId) {
    return (query as any).eq("user_id", userId);
  }
  return (query as any).is("user_id", null);
}

/**
 * Return an object suitable for spreading into an insert payload to scope
 * the row to the current tenant. Use it in inserts to ensure user_id is
 * always populated.
 *
 * Example:
 *   await supabase.from("trades").insert({ ...tenantInsertFields(userId), ticker: "..." });
 */
export function tenantInsertFields(userId: string | null): { user_id: string | null } {
  return { user_id: userId };
}
