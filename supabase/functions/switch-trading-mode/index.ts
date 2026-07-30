import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { checkEntitlement, type SubscriptionRow } from "../_shared/billing.ts";
import { resolveTenant } from "../_shared/tenant.ts";

/**
 * switch-trading-mode: Atomically switches a user between paper and live trading.
 *
 * Accepts either:
 *   - User JWT in Authorization header (direct client call)
 *   - Service-role key + user_id in body (internal edge-function-to-edge-function call,
 *     e.g. trading-agent → switch-trading-mode)
 *
 * For live mode, validates:
 *   1. Active subscription with liveTradingEnabled
 *   2. Kalshi API key present (provider = 'kalshi_live')
 *   3. No HITL approvals pending
 *
 * On success:
 *   - Updates profiles.trading_mode
 *   - Activates/deactivates the appropriate strategy rows
 *   - Logs to compliance_log
 */

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight(req);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const body = await req.json().catch(() => ({}));

    // ── Auth: user JWT or service-role + user_id in body ────────────────────
    const { userId, authenticated } = await resolveTenant(req, supabase, body);
    if (!userId) {
      return json({ error: "unauthorized", message: "Authentication required." }, 401);
    }
    // Reject unauthenticated external callers (not service-role, not valid JWT)
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^[Bb]earer\s+/, "");
    if (!authenticated && bearer !== serviceKey) {
      return json({ error: "unauthorized", message: "Invalid token." }, 401);
    }

    // ── Input ───────────────────────────────────────────────────────────────
    const target_mode = body.target_mode as string | undefined;
    if (target_mode !== "paper" && target_mode !== "live") {
      return json({ error: "invalid_mode", message: "target_mode must be 'paper' or 'live'." }, 400);
    }

    // ── Live-mode validation ─────────────────────────────────────────────────
    if (target_mode === "live") {
      // 1. Subscription entitlement
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      const entitlement = checkEntitlement({ subscription: sub as SubscriptionRow | null, mode: "live" });
      if (!entitlement.allowed) {
        return json({
          error: "subscription_required",
          message: entitlement.reason ?? "Live trading requires a Starter plan or higher. Upgrade in Settings → Billing.",
        }, 403);
      }

      // 2. Kalshi key
      const { data: keyRow } = await supabase
        .from("api_keys")
        .select("id")
        .eq("user_id", userId)
        .eq("provider", "kalshi_live")
        .maybeSingle();

      if (!keyRow) {
        return json({
          error: "no_kalshi_key",
          message: "Add your Kalshi API key in Settings → Connections first.",
        }, 400);
      }

      // 3. Pending HITL approvals
      const { data: pendingHitl } = await supabase
        .from("hitl_approvals")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "pending")
        .limit(1);

      if (pendingHitl && pendingHitl.length > 0) {
        return json({
          error: "hitl_pending",
          message: "You have a live trade awaiting your approval. Resolve it in the HITL panel before switching modes.",
        }, 409);
      }
    }

    // ── Read current mode for compliance log ─────────────────────────────────
    const { data: profile } = await supabase
      .from("profiles")
      .select("trading_mode")
      .eq("id", userId)
      .maybeSingle();
    const from_mode = profile?.trading_mode ?? "paper";

    // ── DB updates ───────────────────────────────────────────────────────────
    await supabase.from("profiles").update({ trading_mode: target_mode }).eq("id", userId);

    let activeStrategies: { id: string; name: string; mode: string }[] = [];

    if (target_mode === "live") {
      await supabase.from("strategies")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("mode", "paper");
      const { data: activated } = await supabase
        .from("strategies")
        .update({ active: true, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("mode", "live")
        .select("id, name, mode");
      activeStrategies = activated ?? [];
    } else {
      await supabase.from("strategies")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("mode", "live");
      const { data: activated } = await supabase
        .from("strategies")
        .update({ active: true, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("mode", "paper")
        .select("id, name, mode");
      activeStrategies = activated ?? [];
    }

    // ── Compliance log ───────────────────────────────────────────────────────
    const trace_id = crypto.randomUUID();
    await supabase.from("compliance_log").insert({
      event_type: "trading_mode_switch",
      category: "account",
      severity: "info",
      message: `User switched trading mode from ${from_mode} to ${target_mode}.`,
      user_id: userId,
      metadata: { from_mode, target_mode, trace_id, active_strategy_ids: activeStrategies.map(s => s.id) },
    });

    return json({ success: true, mode: target_mode, active_strategies: activeStrategies });

  } catch (err: any) {
    return json({ error: "internal_error", message: err.message }, 500);
  }
});
