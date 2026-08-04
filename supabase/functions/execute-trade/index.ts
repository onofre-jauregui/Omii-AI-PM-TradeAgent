import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateAuthHeaders, getKalshiCredentials, KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";
import { corsHeadersExtended as corsHeaders, preflight } from "../_shared/cors.ts";
import { evaluateRisk, evaluateCapitalCap, type RiskSettings, type RiskState } from "../_shared/risk.ts";
import { resolveTenant, getRiskStateToday, setRiskHalt } from "../_shared/tenant.ts";
import { resolveEffectiveLimits, countTradesInWindow } from "../_shared/limits.ts";
import { isServiceRoleBearer } from "../_shared/auth-helpers.ts";
import { captureException, captureMessage } from "../_shared/sentry.ts";
import { checkEntitlement } from "../_shared/billing.ts";
import { alertOnce } from "../_shared/telegram.ts";
import { sendUserNotification } from "../_shared/notifications.ts";
import { fetchOrderbook } from "../_shared/kalshi-market-data.ts";
import { computeDepthAtPrice, simulatePaperFill, estimateKalshiFee } from "../_shared/fill-sim.ts";

function getKalshiBaseUrl(): string {
  return Deno.env.get("KALSHI_BASE_URL") || KALSHI_BASE_URL;
}

// ─── Per-User Rate Limiting ──────────────────────────────────

async function checkRateLimit(supabase: any, userId: string, isPaper: boolean): Promise<boolean> {
  const limit = isPaper ? 15 : 3;
  const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();

  // Keyed per mode: the (user_id, endpoint, window_start) unique constraint has no
  // mode column, so a bare "execute-trade" key lets paper fills (15/min budget) and
  // live orders (3/min budget) increment the same counter. A user's own paper
  // activity can then exhaust the shared count before any live order is attempted,
  // rejecting every live leg that minute even though live made zero prior calls.
  const { data, error } = await supabase.rpc("upsert_rate_limit", {
    p_user_id: userId,
    p_endpoint: isPaper ? "execute-trade:paper" : "execute-trade:live",
    p_window_start: windowStart,
    p_limit: limit,
  });

  if (error) {
    console.error("rate limit check error:", error.message);
    return true; // fail open on rate limit DB error — don't block trades due to infra issue
  }

  return data === true;
}

// ─── Compliance Logging ──────────────────────────────────────

async function logCompliance(
  supabase: any,
  userId: string | null,
  tradeId: string | null,
  eventType: string,
  severity: string,
  message: string,
  metadata: any = {}
) {
  await supabase.from("compliance_log").insert({
    user_id: userId,
    trade_id: tradeId,
    event_type: eventType,
    severity,
    message,
    metadata,
  });
}

// ─── Liquidity Check & Fallback ──────────────────────────────

interface LiquidityCheck {
  sufficient: boolean;
  adjustedPrice?: number;
  fallbackAction?: string;
  tickerGone?: boolean;
}

async function checkLiquidity(
  supabase: any,
  userId: string | null,
  ticker: string,
  side: string,
  action: string,
  price: number,
  amount: number
): Promise<LiquidityCheck> {
  try {
    const result = await fetchOrderbook(getKalshiBaseUrl(), ticker);
    if (!result.ok) {
      // 404/410 mean the ticker doesn't exist or was delisted (e.g. a bracket rolled
      // out of the strike ladder between signal detection and execution) — submitting
      // an order to Kalshi for it will always fail. Flag it so the caller skips the
      // doomed order submission instead of wasting a round trip on a dead ticker.
      if (!result.tickerGone) {
        // Transient network/5xx/malformed-body failure, not a real delisting — log it
        // so a genuine Kalshi outage is visible instead of silently falling through to
        // the same retry path as an expected ticker rollout.
        await logCompliance(supabase, userId, null, "orderbook_fetch_failed", "warning",
          `Orderbook fetch failed for ${ticker}${result.status ? ` (status ${result.status})` : ""}${result.error ? `: ${result.error}` : ""}`,
          { ticker, status: result.status, error: result.error ?? null }
        );
      }
      return { sufficient: false, fallbackAction: "retry_with_limit", tickerGone: result.tickerGone };
    }

    const depth = computeDepthAtPrice(result.orderbook, side as "yes" | "no", action as "buy" | "sell", price, amount);

    if (depth.availableContracts === 0) {
      await logCompliance(supabase, userId, null, "liquidity_fallback", "warning",
        `No liquidity on ${side} ${action} side for ${ticker}. Placing limit order instead.`,
        { ticker, side, action, price, amount }
      );
      return {
        sufficient: false,
        fallbackAction: "limit_order_at_price",
        adjustedPrice: price,
      };
    }

    if (!depth.sufficient) {
      await logCompliance(supabase, userId, null, "liquidity_fallback", "warning",
        `Insufficient liquidity for ${depth.contractsNeeded} contracts on ${ticker}. Available: ${depth.availableContracts}. Splitting order.`,
        { ticker, needed: depth.contractsNeeded, available: depth.availableContracts }
      );
      return {
        sufficient: false,
        fallbackAction: "partial_fill_then_limit",
        adjustedPrice: price,
      };
    }

    return { sufficient: true };
  } catch (e) {
    console.error("Liquidity check failed:", e instanceof Error ? e.message : e);
    return { sufficient: false, fallbackAction: "limit_order_at_price" };
  }
}

// ─── Main Handler ────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight("extended");

  try {
    // Parse the body ONCE so we can forward the parsed object to
    // resolveTenant (req.clone().json() fails after the first read).
    const parsedBody = await req.json();
    const {
      ticker, marketId, marketQuestion, side, action, price, amount,
      strategy, strategyId, mode, notes, orderType, timeInForce,
      expectedOutcome, confidenceLevel, traceId, expirationTime,
      sourceSignalId, influencedByMemoryIds, systemVersion, exitReason,
    } = parsedBody;

    const resolvedTicker = ticker || marketId;

    // Validate required fields
    if (!resolvedTicker || !side || !action || !price || !amount) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: ticker, side, action, price, amount" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!["yes", "no"].includes(side) || !["buy", "sell"].includes(action)) {
      return new Response(
        JSON.stringify({ error: "Invalid side (yes/no) or action (buy/sell)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (price < 1 || price > 99) {
      return new Response(
        JSON.stringify({ error: "Price must be between 1 and 99 cents" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ error: "Server configuration error: missing Supabase credentials" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Tenant Resolution (multi-tenancy) ──
    const { userId, authenticated } = await resolveTenant(req, supabase, parsedBody);

    // Reject unauthenticated external callers. The only legitimate unauthenticated
    // path is internal service-role calls (auto-trade → execute-trade), which supply
    // the service role key in the Authorization header and a user_id in the body.
    if (!authenticated) {
      const bearer = (req.headers.get("Authorization") || req.headers.get("authorization") || "").replace(/^[Bb]earer\s+/, "");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!isServiceRoleBearer(bearer, serviceKey)) {
        // Log every rejection — the most common cause is an internal misconfiguration
        // (missing/rotated service role key), not an external attacker. Logging here
        // makes these failures visible on the observability page instead of dark.
        await supabase.from("compliance_log").insert({
          event_type: "auth_rejected",
          category: "compliance",
          severity: "error",
          message: "execute-trade: request rejected — unauthenticated and not service-role",
          metadata: {
            bearer_present: !!bearer,
            service_key_configured: !!serviceKey,
            ticker: resolvedTicker,
            user_id_in_body: parsedBody?.user_id ?? null,
          },
          user_id: null,
        }).then(undefined, () => {}); // never block the rejection on a log failure — supabase's
        // query builder is a thenable, not a real Promise, so .catch() doesn't exist on it and
        // throws a TypeError before the insert even resolves (same failure class as the
        // 2026-07-06 auto-trade and 2026-07-26 daily-digest incidents)
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const tradeMode = (mode || "paper") as "paper" | "live";

    // ── Per-User Rate Limiting ──
    // Paper: 15 trades/min (data collection), Live: 3 trades/min (real money)
    if (userId) {
      const allowed = await checkRateLimit(supabase, userId, tradeMode === "paper");
      if (!allowed) {
        const limitLabel = tradeMode === "paper" ? "15" : "3";
        await logCompliance(supabase, userId, null, "rate_limit_exceeded", "warning",
          `Rate limit exceeded on execute-trade for user ${userId} (mode: ${tradeMode})`,
          { endpoint: "execute-trade", mode: tradeMode, limit: limitLabel }
        );
        return new Response(
          JSON.stringify({ error: `Rate limit exceeded. Maximum ${limitLabel} trades per minute.` }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Effective limits — single source of truth ──
    // One resolve of the user's mode-scoped risk_settings + subscription tier.
    // Every numeric cap below reads from this instead of re-fetching or
    // re-deriving. Null only for the legacy no-user path (no caps, as before).
    const effective = userId ? await resolveEffectiveLimits(supabase, userId, tradeMode) : null;

    // ── Subscription Entitlement Check ──
    // The allowed/blocked policy gate — subscription status, live access, strategy
    // access, position size — applies to live money only.
    if (userId && effective) {
      // Resolve the request's strategyId to its DB row's template_id — never
      // trust the request string for entitlement. checkEntitlement now does
      // exact template matching (the old /^S-\d+/ normalization let any id
      // PREFIXED with an entitled template, e.g. "S-002-anything", inherit
      // that template's live access). No row / no template_id → null, which
      // checkEntitlement fails closed for live.
      let resolvedTemplateId: string | null = null;
      if (strategyId) {
        const { data: stratRow } = await supabase
          .from("strategies")
          .select("template_id, id, user_id")
          .eq("id", strategyId)
          .maybeSingle();
        // Only honor rows owned by this user or system rows (user_id null) —
        // a strategy id belonging to another tenant confers nothing.
        if (stratRow && (stratRow.user_id === userId || stratRow.user_id === null)) {
          resolvedTemplateId = stratRow.template_id ?? stratRow.id;
        }
      }
      const entitlement = checkEntitlement({
        subscription: effective.subscription,
        strategy: resolvedTemplateId ?? undefined,
        mode: tradeMode,
        positionUsd: amount,
      });

      if (tradeMode === "live" && !entitlement.allowed) {
        await logCompliance(supabase, userId, null, "entitlement_blocked", "warning",
          entitlement.reason!, { strategyId, mode: "live", amount });
        return new Response(
          JSON.stringify({ error: entitlement.reason }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Daily Trade Count Cap (per tier, scoped to this mode) ──
    // Enforces the trades/day figure the billing page advertises. Behavior
    // unchanged: the tier ceiling (with per-customer overrides), mode-scoped count.
    if (userId && effective) {
      const tradesToday = await countTradesInWindow(supabase, userId, tradeMode, 24);
      const dailyCap = effective.tier.maxTradesPerDay;
      if (tradesToday >= dailyCap) {
        await logCompliance(supabase, userId, null, "daily_trade_cap_enforced", "warning",
          `Trade rejected: daily trade cap (${dailyCap}) reached for user ${userId} in ${tradeMode} mode`,
          { mode: tradeMode, count: tradesToday, limit: dailyCap }
        );
        return new Response(JSON.stringify({
          success: false,
          error: `Daily trade limit (${dailyCap} for ${tradeMode} mode) reached. Upgrade for a higher limit or try again tomorrow.`,
        }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── Expiration guard — reject trades on already-closed markets ──
    // Enforced at the transaction boundary so no strategy (present or future) can
    // place a trade on an expired market regardless of its own pre-flight checks.
    if (expirationTime && new Date(expirationTime) < new Date()) {
      await logCompliance(supabase, userId, null, "trade_rejected_expired", "warning",
        `Trade rejected: market ${resolvedTicker} expired at ${expirationTime}`,
        { ticker: resolvedTicker, expirationTime }
      );
      return new Response(JSON.stringify({
        success: false,
        error: `Market ${resolvedTicker} has already expired.`,
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Atomic position cap — race-condition-proof enforcement ──
    // Pre-flight checks in auto-trade are observability only; this layer is authoritative.
    // Any concurrent basket legs that overflow the cap are rejected here, not pre-screened.
    // Captured for the risk check below. risk_state is mode-scoped now
    // (20260801_risk_state_mode.sql), but this count is still the authoritative
    // input to evaluateRisk: it is read inside the same request that places the
    // order, whereas the stored column is only as fresh as the last write.
    let modeScopedOpenCount: number | null = null;
    if (userId && effective) {
      // effective.maxOpenPositions already applies the tier ceiling for live
      // (min(user, tier)) and the user's own cap for paper — the single source
      // of truth, replacing the prior inline min() computation.
      const maxPos = effective.maxOpenPositions;
      // Count open positions in THIS mode only — paper positions must not consume
      // the live cap (and vice-versa).
      const { count: openCount } = await supabase
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("mode", tradeMode)
        .eq("status", "filled")
        .is("settled_at", null)
        .is("exit_reason", null);
      modeScopedOpenCount = openCount ?? 0;

      if ((openCount ?? 0) >= maxPos) {
        await logCompliance(supabase, userId, null, "position_cap_enforced", "warning",
          `Trade rejected: position cap (${maxPos}) reached for user ${userId} — ${openCount} open`,
          { ticker: resolvedTicker, open: openCount, limit: maxPos }
        );
        return new Response(JSON.stringify({
          success: false,
          error: `Position limit (${maxPos}) reached. Settle existing positions before opening new ones.`,
        }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── Risk Management (tenant-scoped) ──
    // Preserve the prior null-vs-configured semantics exactly: evaluateRisk and
    // the capital cap must see `null` when the user has no risk_settings row (so
    // an unconfigured legacy tenant passes unconditionally), NOT the normalized
    // defaults. effective.configured is true iff a real row exists for this mode.
    const settings: RiskSettings | null =
      effective && effective.configured ? effective.riskSettings : null;
    // risk_state is now scoped per (user_id, date, MODE) — paper P&L and
    // positions can no longer trip live halts or caps (the deferred "PR6").
    const riskState = await getRiskStateToday(supabase, userId, tradeMode as "paper" | "live");
    // Belt-and-braces: the override predates mode-scoping (paper positions were
    // blocking live via the shared row). Harmless now — the mode-scoped count
    // is authoritative either way — kept until legacy mixed rows age out.
    if (riskState && modeScopedOpenCount !== null) {
      (riskState as any).open_position_count = modeScopedOpenCount;
    }

    // Fail-closed for live: evaluateRisk treats a missing risk_settings row as "no limits",
    // which would let a real-money order through unbounded. Require configured limits before
    // any live trade rather than defaulting to permissive.
    if (tradeMode === "live" && !settings) {
      await logCompliance(supabase, userId, null, "risk_check_failed", "warning",
        "Live trading requires configured risk limits",
        { amount, price, side, action, ticker: resolvedTicker, code: "no_risk_settings", trace_id: traceId });
      return new Response(JSON.stringify({
        success: false,
        code: "no_risk_settings",
        error: "Live trading requires configured risk limits. Open Risk Controls and set your limits before trading live.",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let riskCheck = evaluateRisk(
      amount,
      tradeMode as "paper" | "live",
      settings as RiskSettings | null,
      riskState as RiskState | null
    );

    // Aggregate live-exposure cap (allocated_capital). Needs a DB sum, so it runs
    // here and folds into riskCheck so the existing failure path handles logging +
    // the failed-trade row. This makes allocated_capital a real cap on EVERY live
    // path (single order, auto-trade leg, chat) — not just multi-leg baskets.
    if (riskCheck.passed && tradeMode === "live" && userId && settings) {
      const cap = (settings as any).allocated_capital ?? 500;
      const { data: openLive } = await supabase
        .from("trades")
        .select("amount")
        .eq("user_id", userId)
        .eq("mode", "live")
        .in("status", ["filled", "open", "partial"])
        .is("settled_at", null);
      const openExposure = (openLive ?? []).reduce((s: number, t: any) => s + (t.amount ?? 0), 0);
      const capCheck = evaluateCapitalCap(openExposure, amount, cap);
      if (!capCheck.passed) {
        riskCheck = { passed: false, code: capCheck.code, reason: capCheck.reason };
      }
    }

    // If the evaluator says we should set a new halt reason, persist it (per-user).
    if (riskCheck.newHaltReason && userId) {
      const { error: haltErr } = await setRiskHalt(supabase, userId, true, riskCheck.newHaltReason, tradeMode as "paper" | "live");
      if (haltErr) {
        captureMessage(`execute-trade failed to persist auto-halt: ${haltErr.message ?? haltErr}`, "error", {
          function: "execute-trade", extra: { userId, reason: riskCheck.newHaltReason },
        });
      }
    }

    if (!riskCheck.passed) {
      captureMessage(`execute-trade risk check failed: ${riskCheck.reason}`, "warning", {
        function: "execute-trade",
        strategyId: strategyId,
        mode: tradeMode,
        extra: { code: riskCheck.code, amount, price, side, ticker: resolvedTicker },
      });
      const { data: failedTrade } = await supabase.from("trades").insert({
        user_id: userId,
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: tradeMode,
        status: "failed",
        exchange: tradeMode === "paper" ? "paper" : "kalshi",
        expiration_time: expirationTime || null,
        notes: `Risk check failed (${riskCheck.code || "unknown"}): ${riskCheck.reason}`,
      }).select().single();

      await logCompliance(supabase, userId, failedTrade?.id, "risk_check_failed", "warning",
        riskCheck.reason!, { amount, price, side, action, code: riskCheck.code, trace_id: traceId });

      return new Response(JSON.stringify({
        success: false,
        error: riskCheck.reason,
        trade: failedTrade,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Paper Trading ──
    if (tradeMode === "paper") {
      // Simulate the fill against the REAL Kalshi orderbook — paper is meant to
      // preview live performance, so it must face the same fill risk (and cost)
      // live does, not an unconditional instant fill at the requested price.
      const orderbookResult = await fetchOrderbook(getKalshiBaseUrl(), resolvedTicker);

      if (!orderbookResult.ok) {
        // A dead/delisted ticker fails identically to live — no silent paper fill
        // on a market that couldn't actually be traded.
        const { data: failedTrade } = await supabase.from("trades").insert({
          user_id: userId,
          ticker: resolvedTicker,
          market_id: resolvedTicker,
          market_question: marketQuestion || resolvedTicker,
          side, action, price, amount,
          strategy: strategy || null,
          strategy_id: strategyId || null,
          mode: "paper",
          status: "failed",
          exchange: "paper",
          expiration_time: expirationTime || null,
          notes: orderbookResult.tickerGone
            ? "Market no longer listed on Kalshi (stale signal) — skipped before simulated fill"
            : "Could not read real orderbook to simulate fill — skipped",
          trace_id: traceId || null,
        }).select().single();

        await logCompliance(supabase, userId, failedTrade?.id, "order_skipped_ticker_gone", "warning",
          `Paper: skipped ${resolvedTicker} — real orderbook unavailable (tickerGone: ${orderbookResult.tickerGone}${orderbookResult.error ? `, error: ${orderbookResult.error}` : ""})`,
          { ticker: resolvedTicker, trace_id: traceId, status: orderbookResult.status, error: orderbookResult.error ?? null }
        );

        return new Response(JSON.stringify({
          success: false,
          error: orderbookResult.tickerGone
            ? `Market ${resolvedTicker} is no longer listed on Kalshi.`
            : `Could not read real orderbook for ${resolvedTicker}.`,
          trade: failedTrade,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const fillResult = simulatePaperFill(orderbookResult.orderbook, side as "yes" | "no", action as "buy" | "sell", price, amount);
      const hasFill = fillResult.status === "filled" || fillResult.status === "partial";
      const isMakerFill = fillResult.status !== "filled"; // didn't fully cross the book immediately
      const entryFeeCents = hasFill ? estimateKalshiFee(fillResult.filledPrice!, fillResult.filledContracts, isMakerFill) : 0;

      const { data: trade, error: insertError } = await supabase.from("trades").insert({
        user_id: userId,
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: "paper",
        status: fillResult.status,
        order_id: `paper-${crypto.randomUUID()}`,
        filled_price: fillResult.filledPrice,
        filled_at: hasFill ? new Date().toISOString() : null,
        slippage_cents: fillResult.slippageCents,
        entry_fee_cents: entryFeeCents,
        exchange: "paper",
        order_type: orderType || "limit",
        expiration_time: expirationTime || null,
        pnl: 0,
        notes: (notes ? `${notes} ` : "") + `Paper (simulated vs real book): ${fillResult.status}, ${fillResult.filledContracts}/${fillResult.requestedContracts} filled` + (fillResult.filledPrice != null ? ` @ ${fillResult.filledPrice}c (intended ${price}c, slippage ${fillResult.slippageCents}c)` : ""),
        trace_id: traceId || null,
        source_signal_id: sourceSignalId || null,
        influenced_by_memory_ids: influencedByMemoryIds || [],
        system_version: systemVersion || 'v1',
        exit_reason: exitReason ?? null,
      }).select().single();

      if (insertError) {
        captureException(insertError, {
          function: "execute-trade",
          strategyId,
          mode: "paper",
          extra: { ticker: resolvedTicker, side, action, price, amount },
        });
        throw insertError;
      }

      // Create trade reflection if agent provided expected outcome
      if (expectedOutcome) {
        await supabase.from("trade_reflections").insert({
          trade_id: trade.id,
          expected_outcome: expectedOutcome,
          expected_confidence: confidenceLevel || null,
          decision_quality: "unknown",
        });
      }

      // Write memory attribution rows for every cited memory
      if (influencedByMemoryIds && influencedByMemoryIds.length > 0) {
        const attributionRows = influencedByMemoryIds.map((memId: string) => ({
          trade_id: trade.id,
          memory_id: memId,
        }));
        await supabase.from("memory_attribution").insert(attributionRows);
      }

      const eventType = fillResult.status === "filled" ? "order_filled" : "order_submitted";
      await logCompliance(supabase, userId, trade.id, eventType, "info",
        `Paper trade ${fillResult.status}: ${action} ${side} ${resolvedTicker} @ ${price}c for $${amount}`,
        { trade_id: trade.id, mode: "paper", reasoning: notes, authenticated }
      );

      // Update daily risk state for this tenant
      await updateRiskState(supabase, userId, 0, tradeMode as "paper" | "live", settings);

      return new Response(JSON.stringify({
        success: true, trade,
        message: `Paper trade ${fillResult.status}: ${action.toUpperCase()} ${side.toUpperCase()} ${resolvedTicker} @ ${price}c for $${amount}`,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Live Trading on Kalshi ──
    // Pull credentials for THIS user, decrypted via the encryption helper.
    const { keyId: kalshiKeyId, privateKey: kalshiPrivateKey } = await getKalshiCredentials(supabase, userId);

    if (!kalshiKeyId || !kalshiPrivateKey) {
      const { data: failedTrade } = await supabase.from("trades").insert({
        user_id: userId,
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: "live",
        status: "failed",
        exchange: "kalshi",
        expiration_time: expirationTime || null,
        notes: "Kalshi API credentials not configured.",
      }).select().single();

      await logCompliance(supabase, userId, failedTrade?.id, "order_failed", "error",
        "Live trade failed: Kalshi API credentials not configured",
        { ticker: resolvedTicker });

      // Alert once per user — creds missing blocks ALL live trades until fixed.
      await alertOnce(supabase, "kalshi_creds_missing", userId || "unknown", 6,
        `🔑 <b>[TradeAgent] Kalshi Credentials Missing</b>\nA live trade was attempted but no Kalshi API key found for user <code>${userId}</code>.\nTicker: ${resolvedTicker}\nAdd keys in Settings → Kalshi API Key.`
      );

      return new Response(JSON.stringify({
        success: false,
        error: "Kalshi API credentials not configured. Add KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY in Settings.",
        trade: failedTrade,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Check liquidity before placing order
    const liquidityCheck = await checkLiquidity(supabase, userId, resolvedTicker, side, action, price, amount);

    if (liquidityCheck.tickerGone) {
      // Ticker no longer exists on Kalshi (delisted/rolled out of the strike ladder
      // since the signal was detected) — submitting would just 410. Fail fast instead
      // of wasting a round trip on a dead order.
      const { data: failedTrade } = await supabase.from("trades").insert({
        user_id: userId,
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: tradeMode,
        status: "failed",
        exchange: "kalshi",
        expiration_time: expirationTime || null,
        notes: "Market no longer listed on Kalshi (stale signal) — skipped before order submission",
      }).select().single();

      await logCompliance(supabase, userId, failedTrade?.id, "order_skipped_ticker_gone", "warning",
        `Skipped ${resolvedTicker}: market no longer listed on Kalshi (stale signal)`,
        { ticker: resolvedTicker, trace_id: traceId }
      );

      return new Response(JSON.stringify({
        success: false,
        error: `Market ${resolvedTicker} is no longer listed on Kalshi.`,
        trade: failedTrade,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const resolvedOrderType = liquidityCheck.sufficient ? (orderType || "limit") : "limit";

    // Calculate contract count: amount in dollars / price per contract
    const pricePerContract = price / 100; // cents to dollars
    const contractCount = Math.max(1, Math.floor(amount / pricePerContract));

    // ── Kalshi V2 order schema (legacy /portfolio/orders is deprecated) ──
    // V2 quotes every order from the YES-book bid/ask perspective — there is no
    // separate yes/no side. Buying/selling NO is represented as the complementary
    // YES-side order at (1 - price): confirmed against live Kalshi market data,
    // where yes_bid + no_ask == 1.00 and yes_ask + no_bid == 1.00 exactly.
    //   buy YES  -> bid @ price
    //   sell YES -> ask @ price
    //   buy NO   -> ask @ (1 - price)   (economically: selling YES at 1-price)
    //   sell NO  -> bid @ (1 - price)   (economically: buying YES at 1-price)
    const priceDollars = price / 100;
    const v2Side: "bid" | "ask" =
      side === "yes"
        ? (action === "buy" ? "bid" : "ask")
        : (action === "buy" ? "ask" : "bid");
    const v2PriceDollars = side === "yes" ? priceDollars : 1 - priceDollars;

    // Pre-flight balance check. Kalshi's own insufficient_balance rejection only
    // arrives after we submit the order — every doomed leg still costs a full
    // round trip, and nothing distinguished "account is out of money" from any
    // other 400 until this check, so a strategy would keep retrying the same
    // unaffordable basket every scan cycle indefinitely. Buying costs price*count;
    // selling (opening a short) requires (1-price)*count in collateral — the
    // exchange's standard per-contract margin, same formula used by kalshi-ping.
    const requiredCollateralDollars = v2Side === "bid"
      ? contractCount * v2PriceDollars
      : contractCount * (1 - v2PriceDollars);

    const balancePath = "/trade-api/v2/portfolio/balance";
    const balanceHeaders = await generateAuthHeaders(kalshiKeyId, kalshiPrivateKey, "GET", balancePath, Date.now());
    const balanceResp = await fetch(`${getKalshiBaseUrl()}/portfolio/balance`, { headers: balanceHeaders });

    if (balanceResp.ok) {
      const balanceData = await balanceResp.json();
      const availableDollars = (balanceData?.balance ?? 0) / 100;

      if (availableDollars < requiredCollateralDollars) {
        const { data: failedTrade } = await supabase.from("trades").insert({
          user_id: userId,
          ticker: resolvedTicker,
          market_id: resolvedTicker,
          market_question: marketQuestion || resolvedTicker,
          side, action, price, amount,
          strategy: strategy || null,
          strategy_id: strategyId || null,
          mode: "live",
          status: "failed",
          exchange: "kalshi",
          expiration_time: expirationTime || null,
          notes: `Skipped pre-flight: needs $${requiredCollateralDollars.toFixed(2)}, account has $${availableDollars.toFixed(2)}`,
        }).select().single();

        await logCompliance(supabase, userId, failedTrade?.id, "order_skipped_insufficient_balance", "warning",
          `Skipped ${resolvedTicker} ${v2Side} ${contractCount}x @ ${price}c — needs $${requiredCollateralDollars.toFixed(2)}, account has $${availableDollars.toFixed(2)}`,
          { required_usd: requiredCollateralDollars, available_usd: availableDollars, ticker: resolvedTicker, trace_id: traceId }
        );

        // Account-level shortfall, not market-level — one alert per user regardless of ticker,
        // so a multi-leg basket hitting this on every leg doesn't fire N alerts.
        await alertOnce(supabase, "kalshi_insufficient_balance", userId || "unknown", 4,
          `💸 <b>[TradeAgent] Live account balance too low to trade</b>\nSkipped ${resolvedTicker} — needs $${requiredCollateralDollars.toFixed(2)}, have $${availableDollars.toFixed(2)}.\nDeposit funds or the agent keeps skipping live trades every cycle.`
        );

        return new Response(JSON.stringify({
          success: false,
          code: "insufficient_balance",
          error: `Insufficient Kalshi balance: need $${requiredCollateralDollars.toFixed(2)}, have $${availableDollars.toFixed(2)}.`,
          trade: failedTrade,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    // If the balance fetch itself fails (network/auth hiccup), fall through and let
    // the real order call be the source of truth — never block a trade on a monitoring path.

    // V2 has no order "type" field — every order is a limit order at `price`.
    // A requested "market" order is approximated with immediate_or_cancel so it
    // either fills immediately at the given price or is cancelled, rather than resting.
    const requestedTif = (orderType === "market") ? "immediate_or_cancel" : (timeInForce || "gtc");
    // Our own trades ledger predates the V2 migration and its time_in_force
    // column is constrained to the legacy 3-value vocabulary (trades_time_in_force_check:
    // gtc/ioc/day). Normalize any V2-style or "market"-derived value down to that set —
    // this is purely our bookkeeping label, separate from kalshiOrderPayload.time_in_force
    // (the actual value sent to Kalshi) below.
    const ledgerTimeInForce: "gtc" | "ioc" | "day" =
      requestedTif === "day" ? "day" : requestedTif === "gtc" ? "gtc" : "ioc";
    let v2TimeInForce: "fill_or_kill" | "good_till_canceled" | "immediate_or_cancel";
    let v2ExpirationTime: number | undefined;
    if (requestedTif === "fok" || requestedTif === "fill_or_kill") {
      v2TimeInForce = "fill_or_kill";
    } else if (requestedTif === "ioc" || requestedTif === "immediate_or_cancel") {
      v2TimeInForce = "immediate_or_cancel";
    } else {
      // "gtc" and legacy "day" both rest as good_till_canceled; "day" additionally
      // sets expiration_time (Unix seconds) so it still auto-cancels at market close.
      v2TimeInForce = "good_till_canceled";
      if (requestedTif === "day" && expirationTime) {
        v2ExpirationTime = Math.floor(new Date(expirationTime).getTime() / 1000);
      }
    }

    const kalshiOrderPayload: any = {
      ticker: resolvedTicker,
      side: v2Side,
      count: contractCount.toFixed(2),
      price: v2PriceDollars.toFixed(4),
      time_in_force: v2TimeInForce,
      self_trade_prevention_type: "taker_at_cross",
    };
    if (v2ExpirationTime) kalshiOrderPayload.expiration_time = v2ExpirationTime;

    // Log order submission
    await logCompliance(supabase, userId, null, "order_submitted", "info",
      `Submitting ${resolvedOrderType} order: ${action} ${contractCount}x ${side} ${resolvedTicker} @ ${price}c`,
      { payload: kalshiOrderPayload, liquidity_check: liquidityCheck, trace_id: traceId }
    );

    // Place order on Kalshi
    const kalshiBase = getKalshiBaseUrl();
    const orderPath = "/trade-api/v2/portfolio/events/orders";
    const timestamp = Date.now();
    const authHeaders = await generateAuthHeaders(kalshiKeyId, kalshiPrivateKey, "POST", orderPath, timestamp);

    const kalshiResponse = await fetch(`${kalshiBase}/portfolio/events/orders`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(kalshiOrderPayload),
    });

    const kalshiResultRaw = await kalshiResponse.json();
    // Compatibility shim: downstream code expects the legacy `{order: {...}}` shape
    // with remaining_count/avg_price as cents-scale numbers. V2 returns a flat
    // object with fixed-point dollar strings, always quoted from the YES side —
    // convert avg_price back to OUR side's cents convention before it flows further.
    const kalshiResult: any = kalshiResponse.ok
      ? {
          order: {
            order_id: kalshiResultRaw.order_id,
            remaining_count: Math.round(parseFloat(kalshiResultRaw.remaining_count ?? "0")),
            avg_price:
              kalshiResultRaw.average_fill_price != null
                ? Math.round(
                    (side === "yes"
                      ? parseFloat(kalshiResultRaw.average_fill_price)
                      : 1 - parseFloat(kalshiResultRaw.average_fill_price)) * 100
                  )
                : null,
            status: parseFloat(kalshiResultRaw.remaining_count ?? "0") === 0 ? "executed" : "resting",
            // Kalshi reports the real fee it charged directly on the order object —
            // capture it verbatim rather than compute it, so live fee accounting has
            // zero formula risk (unlike paper's estimateKalshiFee, which has none to read).
            maker_fees_dollars: kalshiResultRaw.maker_fees_dollars ?? null,
            taker_fees_dollars: kalshiResultRaw.taker_fees_dollars ?? null,
          },
        }
      : kalshiResultRaw;

    if (!kalshiResponse.ok) {
      // Log full Kalshi error internally — never expose raw API responses to the client
      const rawKalshiError = kalshiResult.message || kalshiResult.error || kalshiResult;
      // Kalshi v2 rejection bodies nest an object under `error` ({code, details,
      // message}) — String() renders that as "[object Object]", which blinded the
      // 2026-07-31 401 incident across the alert, compliance_log, and dead-letter
      // queue. JSON.stringify preserves the payload; the ?? String() fallback covers
      // undefined (empty rejection body), whose .slice() once crashed the handler.
      const kalshiErrorDetail =
        typeof rawKalshiError === "string"
          ? rawKalshiError
          : JSON.stringify(rawKalshiError) ?? String(rawKalshiError);
      console.error(`execute-trade: Kalshi rejected order — status ${kalshiResponse.status}, detail: ${kalshiErrorDetail}`, {
        ticker: resolvedTicker, side, action, price, payload: kalshiOrderPayload,
      });

      const { data: failedTrade } = await supabase.from("trades").insert({
        user_id: userId,
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: "live",
        status: "failed",
        exchange: "kalshi",
        order_type: resolvedOrderType,
        expiration_time: expirationTime || null,
        notes: `Kalshi order rejected (status ${kalshiResponse.status})`,
      }).select().single();

      await logCompliance(supabase, userId, failedTrade?.id, "order_failed", "error",
        `Kalshi order rejected (status ${kalshiResponse.status}): ${kalshiErrorDetail}`,
        { kalshi_status: kalshiResponse.status, kalshi_response: kalshiResult, payload: kalshiOrderPayload, trace_id: traceId }
      );

      // Dead-letter queue — failed live trades are preserved for human inspection and replay
      if (tradeMode === "live") {
        await supabase.from("failed_trade_queue").insert({
          user_id: userId,
          trace_id: traceId || null,
          trade_payload: {
            ticker: resolvedTicker,
            side,
            action,
            price,
            amount,
            strategy: strategy || null,
            strategy_id: strategyId || null,
            mode: "live",
            order_type: resolvedOrderType,
            notes: notes || null,
          },
          failure_reason: kalshiErrorDetail.slice(0, 500),
          kalshi_status: kalshiResponse.status,
        }).then(null, () => {});
      }

      // Alert on first rejection per ticker — persistent rejections on the same market warrant investigation.
      await alertOnce(supabase, "kalshi_order_rejected", `${resolvedTicker}_${kalshiResponse.status}`, 1,
        `❌ <b>[TradeAgent] Kalshi Order Rejected</b>\nStatus: ${kalshiResponse.status}\nTicker: ${resolvedTicker} (${side.toUpperCase()} ${action})\nReason: ${kalshiErrorDetail.slice(0, 200)}`
      );

      // Systemic-outage escalation — a per-ticker rejection alert reads as "this one market
      // is bad" even when the real cause blocks 100% of order submissions (e.g. Kalshi
      // deprecating the endpoint this code calls). Fire one unmistakable critical page,
      // deduped globally, so an outage doesn't hide as N separate low-signal per-ticker alerts.
      if (kalshiResult?.code === "deprecated_v1_order_endpoint") {
        await alertOnce(supabase, "kalshi_order_endpoint_deprecated", "global", 6,
          `🔴 <b>[TradeAgent] ALL Kalshi order submissions are failing</b>\nKalshi has deprecated the /portfolio/orders endpoint this system uses (410 deprecated_v1_order_endpoint). Every live and paper order is being rejected — this is a total trading outage, not an isolated ticker issue.\nFix requires migrating execute-trade to POST /portfolio/events/orders (new bid/ask + fixed-point-dollar schema). See docs/improvement-log.md.`
        );
      }

      // Liquidity fallback: if rejected due to insufficient liquidity, try limit at worse price
      if (liquidityCheck.fallbackAction && !liquidityCheck.sufficient) {
        await logCompliance(supabase, userId, failedTrade?.id, "liquidity_fallback", "warning",
          `Attempting liquidity fallback: ${liquidityCheck.fallbackAction}`,
          { original_price: price, ticker: resolvedTicker }
        );
      }

      return new Response(JSON.stringify({
        success: false,
        error: "Trade execution failed. Please try again.",
        trade: failedTrade,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Order accepted
    const kalshiOrder = kalshiResult.order;
    const orderStatus = kalshiOrder.remaining_count === 0 ? "filled" :
                        kalshiOrder.remaining_count < contractCount ? "partial" : "open";

    // Instrumentation for the live pilot: capture the REAL fill price and slippage
    // on ANY fill (full OR partial), not just full fills. This is how we learn
    // whether the favorable-priced limit orders actually get filled at our price —
    // the one unknown paper cannot answer. Positive slippage = filled worse than intended.
    const hasFill = orderStatus === "filled" || orderStatus === "partial";
    const realFillPrice = hasFill && kalshiOrder.avg_price != null ? kalshiOrder.avg_price : null;
    const slippageCents = realFillPrice != null ? Math.round(realFillPrice - price) : null;
    const filledContracts = contractCount - (kalshiOrder.remaining_count ?? 0);
    // Kalshi reports whichever fee type actually applied (maker if it rested,
    // taker if it crossed immediately) — the other field comes back null/0.
    const entryFeeCents = hasFill
      ? Math.round(parseFloat(kalshiOrder.maker_fees_dollars ?? kalshiOrder.taker_fees_dollars ?? "0") * 100)
      : null;

    const { data: trade, error: insertError } = await supabase.from("trades").insert({
        user_id: userId,
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: "live",
        status: orderStatus,
        exchange: "kalshi",
        order_id: kalshiOrder.order_id,
        order_type: resolvedOrderType,
        // Store OUR ledger's time_in_force vocabulary (gtc/ioc/day — trades_time_in_force_check),
        // not Kalshi's v2 payload vocabulary (fill_or_kill/good_till_canceled/immediate_or_cancel).
        time_in_force: ledgerTimeInForce,
        expiration_time: expirationTime || null,
        filled_price: realFillPrice,
        filled_at: hasFill ? new Date().toISOString() : null,
        slippage_cents: slippageCents,
        entry_fee_cents: entryFeeCents,
        pnl: 0,
        notes: (notes ? `${notes} ` : "") + `Live Kalshi order ${kalshiOrder.order_id}: ${orderStatus}, ${filledContracts}/${contractCount} filled` + (realFillPrice != null ? ` @ ${realFillPrice}c (intended ${price}c, slippage ${slippageCents}c)` : ""),
        trace_id: traceId || null,
        source_signal_id: sourceSignalId || null,
        influenced_by_memory_ids: influencedByMemoryIds || [],
        system_version: systemVersion || 'v1',
        exit_reason: exitReason ?? null,
      }).select().single();

    if (insertError) throw insertError;

    // Write memory attribution rows for every cited memory
    if (influencedByMemoryIds && influencedByMemoryIds.length > 0) {
      const attributionRows = influencedByMemoryIds.map((memId: string) => ({
        trade_id: trade.id,
        memory_id: memId,
      }));
      await supabase.from("memory_attribution").insert(attributionRows);
    }

    const eventType = orderStatus === "filled" ? "order_filled" : "order_submitted";
    await logCompliance(supabase, userId, trade.id, eventType, "info",
      `Kalshi order ${kalshiOrder.order_id}: ${orderStatus} - ${action} ${contractCount}x ${side} ${resolvedTicker} @ ${price}c`,
      { order_id: kalshiOrder.order_id, kalshi_status: kalshiOrder.status, remaining: kalshiOrder.remaining_count }
    );

    // Notify user of live fill (fire-and-forget — never blocks response)
    if (orderStatus === "filled") {
      const fillPrice = (kalshiOrder.avg_price ?? price) / 100;
      sendUserNotification(supabase, {
        userId,
        eventType: "trade_executed",
        subject: `Trade filled: ${side.toUpperCase()} ${resolvedTicker}`,
        htmlBody: `
          <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 4px;">${action.toUpperCase()} ${side.toUpperCase()}</h2>
          <p style="color:rgba(255,255,255,0.5);font-size:14px;margin:0 0 24px;">${resolvedTicker}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
            <tr><td style="color:rgba(255,255,255,0.5);padding:6px 0;">Fill price</td><td style="color:#fff;text-align:right;">${fillPrice.toFixed(2)}¢</td></tr>
            <tr><td style="color:rgba(255,255,255,0.5);padding:6px 0;">Amount</td><td style="color:#fff;text-align:right;">$${amount}</td></tr>
            <tr><td style="color:rgba(255,255,255,0.5);padding:6px 0;">Order ID</td><td style="color:rgba(255,255,255,0.4);text-align:right;font-family:monospace;font-size:11px;">${kalshiOrder.order_id}</td></tr>
          </table>`,
        smsBody: `TradeAgent: ${action} ${side.toUpperCase()} ${resolvedTicker} @ ${fillPrice.toFixed(0)}¢ filled ($${amount})`,
      }).catch(() => {});
    }

    // Update risk state for this tenant
    await updateRiskState(supabase, userId, 0, tradeMode as "paper" | "live");

    return new Response(JSON.stringify({
      success: true,
      trade,
      kalshiOrder,
      message: `Live trade ${orderStatus}: ${action.toUpperCase()} ${contractCount}x ${side.toUpperCase()} ${resolvedTicker} @ ${price}c`,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    // Handle Error objects, plain objects (e.g. Supabase errors), and anything else
    let errorMsg: string;
    const errorDetail: any = e;
    if (e instanceof Error) {
      errorMsg = e.message;
    } else if (typeof e === "object" && e !== null) {
      errorMsg = (e as any).message || (e as any).error || JSON.stringify(e);
    } else {
      errorMsg = String(e);
    }
    const errorStack = e instanceof Error ? e.stack : undefined;
    console.error("execute-trade error:", errorMsg);
    if (errorStack) console.error("stack:", errorStack);

    captureException(e instanceof Error ? e : new Error(errorMsg), { function: "execute-trade" });

    // Log system error and alert
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      await logCompliance(supabase, null, null, "system_event", "error",
        `Trade execution error: ${errorMsg}`,
        { raw_error: errorDetail, stack: errorStack }
      );
      await alertOnce(supabase, "execute_trade_fatal", errorMsg.slice(0, 80), 1,
        `🚨 <b>[TradeAgent] execute-trade CRASHED</b>\nUnhandled error in trade execution — live orders may not have been placed.\nError: ${errorMsg.slice(0, 300)}`
      );
    } catch {}

    return new Response(
      JSON.stringify({ error: "Trade execution failed. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ─── Risk State Updates ──────────────────────────────────────

async function updateRiskState(
  supabase: any,
  userId: string | null,
  _pnlChange: number,  // kept for API compat — daily_pnl now computed from settled trades directly
  mode: "paper" | "live",
  riskSettings?: any   // used to seed peak_portfolio_value on first trade of day
) {
  const today = new Date().toISOString().split("T")[0];

  // Count currently-open positions, scoped to tenant AND mode — risk_state is
  // one row per (user_id, date, mode).
  //
  // The settled_at/exit_reason filters are load-bearing: without them this
  // counted every buy that had EVER filled, so the stored value only ever grew
  // (production carried 21/19/11 against 8/3/6 genuinely open before this fix).
  // A "current open positions" number that never decrements is not a count,
  // it's a running total — and it feeds evaluateRisk's max_open_positions gate
  // in _shared/risk.ts.
  //
  // Status set is deliberately broader than the authoritative cap query in the
  // position-cap block above (which uses status='filled'): a resting open or
  // partial buy is real committed exposure for risk-tracking purposes, even
  // though the cap only counts positions actually held.
  const positionQuery = supabase
    .from("trades")
    .select("*", { count: "exact", head: true })
    .in("status", ["filled", "open", "partial"])
    .eq("mode", mode)
    .eq("action", "buy")
    .is("settled_at", null)
    .is("exit_reason", null);
  const { count: openPositionCount } = userId
    ? await positionQuery.eq("user_id", userId)
    : await positionQuery.is("user_id", null);

  // Compute today's settled P&L directly — pnlChange was always passed as 0 (bug fix).
  // Querying settled trades is the only accurate source; incremental tracking drifts.
  const settledQuery = supabase
    .from("trades")
    .select("pnl")
    .eq("status", "settled")
    .eq("mode", mode)
    .gte("settled_at", `${today}T00:00:00.000Z`);
  const { data: todaySettled } = userId
    ? await settledQuery.eq("user_id", userId)
    : await settledQuery.is("user_id", null);
  const actualDailyPnl = (todaySettled ?? []).reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);

  // Get current risk state for this tenant
  const stateQuery = supabase.from("risk_state").select("*").eq("date", today).eq("mode", mode);
  const { data: current } = userId
    ? await stateQuery.eq("user_id", userId).maybeSingle()
    : await stateQuery.is("user_id", null).maybeSingle();

  if (current) {
    const currentPeak = current.peak_portfolio_value || 0;
    const newPeak = actualDailyPnl > currentPeak ? actualDailyPnl : currentPeak;
    const updateQuery = supabase.from("risk_state").update({
      daily_pnl: actualDailyPnl,
      daily_trades: current.daily_trades + 1,
      open_position_count: openPositionCount || 0,
      max_drawdown_today: Math.min(current.max_drawdown_today || 0, actualDailyPnl),
      peak_portfolio_value: newPeak,
      updated_at: new Date().toISOString(),
    }).eq("date", today).eq("mode", mode);
    if (userId) {
      await updateQuery.eq("user_id", userId);
    } else {
      await updateQuery.is("user_id", null);
    }
  } else {
    // Seed peak_portfolio_value from user's allocated capital so the drawdown
    // and concentration checks have a meaningful baseline from day one.
    const seedPeak = riskSettings?.allocated_capital ?? 500;
    await supabase.from("risk_state").insert({
      user_id: userId,
      date: today,
      mode,
      daily_pnl: actualDailyPnl,
      daily_trades: 1,
      open_position_count: openPositionCount || 0,
      max_drawdown_today: Math.min(0, actualDailyPnl),
      peak_portfolio_value: seedPeak,
    });
  }
}
