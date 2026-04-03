import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hmac } from "https://deno.land/x/hmac@v2.0.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Always use production Kalshi API for live data — paper trades are simulated locally
const KALSHI_BASE_URL = "https://trading-api.kalshi.com/trade-api/v2";

function getKalshiBaseUrl(): string {
  return KALSHI_BASE_URL;
}

// Read Kalshi live credentials: DB api_keys table first, env var fallback
async function getKalshiCredentials(supabase: any): Promise<{ keyId: string | null; privateKey: string | null }> {
  const { data } = await supabase
    .from("api_keys")
    .select("key_id, encrypted_secret")
    .eq("provider", "kalshi_live")
    .single();

  return {
    keyId: data?.key_id || Deno.env.get("KALSHI_API_KEY_ID") || null,
    privateKey: data?.encrypted_secret || Deno.env.get("KALSHI_API_PRIVATE_KEY") || null,
  };
}

function generateAuthHeaders(
  apiKeyId: string,
  privateKey: string,
  method: string,
  path: string,
  timestamp: number
): Record<string, string> {
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const signature = hmac("sha256", privateKey, message, "utf8", "base64");
  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature as string,
    "KALSHI-ACCESS-TIMESTAMP": String(timestamp),
    "Content-Type": "application/json",
  };
}

// ─── Risk Management Checks ──────────────────────────────────

interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  riskSettings?: any;
}

async function performRiskChecks(
  supabase: any,
  amount: number,
  mode: string
): Promise<RiskCheckResult> {
  // Paper mode bypasses risk checks
  if (mode === "paper") return { passed: true };

  // Fetch risk settings
  const { data: settings } = await supabase
    .from("risk_settings")
    .select("*")
    .single();

  if (!settings) return { passed: true }; // No settings = no limits

  // Check position size limit
  if (amount > settings.max_position_size) {
    await logCompliance(supabase, null, "risk_check_failed", "warning",
      `Order amount $${amount} exceeds max position size $${settings.max_position_size}`,
      { amount, limit: settings.max_position_size }
    );
    return {
      passed: false,
      reason: `Order amount $${amount} exceeds max position size $${settings.max_position_size}`,
      riskSettings: settings,
    };
  }

  // Get today's risk state
  const today = new Date().toISOString().split("T")[0];
  const { data: riskState } = await supabase
    .from("risk_state")
    .select("*")
    .eq("date", today)
    .single();

  if (riskState) {
    // Check if trading is halted
    if (riskState.is_trading_halted) {
      return {
        passed: false,
        reason: `Trading halted: ${riskState.halt_reason || "daily limits exceeded"}`,
        riskSettings: settings,
      };
    }

    // Check daily loss limit
    if (Math.abs(riskState.daily_pnl) >= settings.max_daily_loss && riskState.daily_pnl < 0) {
      // Halt trading
      await supabase.from("risk_state").upsert({
        date: today,
        is_trading_halted: true,
        halt_reason: `Daily loss limit of $${settings.max_daily_loss} reached`,
        updated_at: new Date().toISOString(),
      }, { onConflict: "date" });

      await logCompliance(supabase, null, "daily_loss_limit_hit", "critical",
        `Daily loss limit of $${settings.max_daily_loss} reached. Trading halted.`,
        { daily_pnl: riskState.daily_pnl, limit: settings.max_daily_loss }
      );

      return {
        passed: false,
        reason: `Daily loss limit of $${settings.max_daily_loss} reached. Trading halted for today.`,
        riskSettings: settings,
      };
    }

    // Check max open positions
    if (riskState.open_position_count >= settings.max_open_positions) {
      await logCompliance(supabase, null, "position_limit_hit", "warning",
        `Max open positions (${settings.max_open_positions}) reached`,
        { current: riskState.open_position_count, limit: settings.max_open_positions }
      );
      return {
        passed: false,
        reason: `Maximum open positions (${settings.max_open_positions}) reached. Close a position first.`,
        riskSettings: settings,
      };
    }

    // Check drawdown
    if (riskState.peak_portfolio_value > 0) {
      const drawdownPct = ((riskState.peak_portfolio_value - (riskState.peak_portfolio_value + riskState.daily_pnl)) / riskState.peak_portfolio_value) * 100;
      if (drawdownPct >= settings.max_drawdown_pct) {
        await supabase.from("risk_state").upsert({
          date: today,
          is_trading_halted: true,
          halt_reason: `Max drawdown of ${settings.max_drawdown_pct}% exceeded`,
          updated_at: new Date().toISOString(),
        }, { onConflict: "date" });

        return {
          passed: false,
          reason: `Max drawdown of ${settings.max_drawdown_pct}% exceeded. Trading halted.`,
          riskSettings: settings,
        };
      }
    }
  }

  await logCompliance(supabase, null, "risk_check_passed", "info",
    `Risk checks passed for $${amount} order`,
    { amount, settings_id: settings.id }
  );

  return { passed: true, riskSettings: settings };
}

// ─── Compliance Logging ──────────────────────────────────────

async function logCompliance(
  supabase: any,
  tradeId: string | null,
  eventType: string,
  severity: string,
  message: string,
  metadata: any = {}
) {
  await supabase.from("compliance_log").insert({
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
}

async function checkLiquidity(
  supabase: any,
  ticker: string,
  side: string,
  action: string,
  price: number,
  amount: number
): Promise<LiquidityCheck> {
  try {
    const kalshiBase = getKalshiBaseUrl();
    const response = await fetch(`${kalshiBase}/markets/${ticker}/orderbook`);
    if (!response.ok) {
      return { sufficient: false, fallbackAction: "retry_with_limit" };
    }

    const orderbook = await response.json();
    const book = side === "yes"
      ? (action === "buy" ? orderbook.yes?.asks : orderbook.yes?.bids)
      : (action === "buy" ? orderbook.no?.asks : orderbook.no?.bids);

    if (!book || book.length === 0) {
      await logCompliance(supabase, null, "liquidity_fallback", "warning",
        `No liquidity on ${side} ${action} side for ${ticker}. Placing limit order instead.`,
        { ticker, side, action, price, amount }
      );
      return {
        sufficient: false,
        fallbackAction: "limit_order_at_price",
        adjustedPrice: price,
      };
    }

    // Check if there's enough depth at our price
    let availableContracts = 0;
    for (const level of book) {
      if (action === "buy" && level.price <= price / 100) {
        availableContracts += level.count;
      } else if (action === "sell" && level.price >= price / 100) {
        availableContracts += level.count;
      }
    }

    const contractsNeeded = Math.ceil(amount / (price / 100));
    if (availableContracts < contractsNeeded) {
      await logCompliance(supabase, null, "liquidity_fallback", "warning",
        `Insufficient liquidity for ${contractsNeeded} contracts on ${ticker}. Available: ${availableContracts}. Splitting order.`,
        { ticker, needed: contractsNeeded, available: availableContracts }
      );
      return {
        sufficient: false,
        fallbackAction: "partial_fill_then_limit",
        adjustedPrice: price,
      };
    }

    return { sufficient: true };
  } catch (e) {
    return { sufficient: false, fallbackAction: "limit_order_at_price" };
  }
}

// ─── Main Handler ────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const {
      ticker, marketId, marketQuestion, side, action, price, amount,
      strategy, strategyId, mode, notes, orderType, timeInForce,
    } = await req.json();

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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const tradeMode = mode || "paper";

    // ── Risk Management ──
    const riskCheck = await performRiskChecks(supabase, amount, tradeMode);
    if (!riskCheck.passed) {
      const { data: failedTrade } = await supabase.from("trades").insert({
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: tradeMode,
        status: "failed",
        exchange: tradeMode === "paper" ? "paper" : "kalshi",
        notes: `Risk check failed: ${riskCheck.reason}`,
      }).select().single();

      await logCompliance(supabase, failedTrade?.id, "risk_check_failed", "warning",
        riskCheck.reason!, { amount, price, side, action });

      return new Response(JSON.stringify({
        success: false,
        error: riskCheck.reason,
        trade: failedTrade,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Paper Trading ──
    if (tradeMode === "paper") {
      const { data: trade, error: insertError } = await supabase.from("trades").insert({
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: "paper",
        status: "filled",
        filled_price: price,
        filled_at: new Date().toISOString(),
        exchange: "paper",
        order_type: orderType || "limit",
        pnl: 0,
        notes: notes || "Paper trade - simulated execution",
      }).select().single();

      if (insertError) throw insertError;

      await logCompliance(supabase, trade.id, "order_filled", "info",
        `Paper trade filled: ${action} ${side} ${resolvedTicker} @ ${price}c for $${amount}`,
        { trade_id: trade.id, mode: "paper" }
      );

      // Update daily risk state
      await updateRiskState(supabase, 0);

      return new Response(JSON.stringify({
        success: true, trade,
        message: `Paper trade: ${action.toUpperCase()} ${side.toUpperCase()} ${resolvedTicker} @ ${price}c for $${amount}`,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Live Trading on Kalshi ──
    const { keyId: kalshiKeyId, privateKey: kalshiPrivateKey } = await getKalshiCredentials(supabase);

    if (!kalshiKeyId || !kalshiPrivateKey) {
      const { data: failedTrade } = await supabase.from("trades").insert({
        ticker: resolvedTicker,
        market_id: resolvedTicker,
        market_question: marketQuestion || resolvedTicker,
        side, action, price, amount,
        strategy: strategy || null,
        strategy_id: strategyId || null,
        mode: "live",
        status: "failed",
        exchange: "kalshi",
        notes: "Kalshi API credentials not configured.",
      }).select().single();

      await logCompliance(supabase, failedTrade?.id, "order_failed", "error",
        "Live trade failed: Kalshi API credentials not configured",
        { ticker: resolvedTicker });

      return new Response(JSON.stringify({
        success: false,
        error: "Kalshi API credentials not configured. Add KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY in Settings.",
        trade: failedTrade,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Check liquidity before placing order
    const liquidityCheck = await checkLiquidity(supabase, resolvedTicker, side, action, price, amount);
    const resolvedOrderType = liquidityCheck.sufficient ? (orderType || "limit") : "limit";

    // Calculate contract count: amount in dollars / price per contract
    const pricePerContract = price / 100; // cents to dollars
    const contractCount = Math.max(1, Math.floor(amount / pricePerContract));

    // Build Kalshi order payload
    const kalshiOrderPayload: any = {
      ticker: resolvedTicker,
      action: action,
      side: side,
      type: resolvedOrderType,
      count: contractCount,
    };

    if (resolvedOrderType === "limit") {
      if (side === "yes") {
        kalshiOrderPayload.yes_price = price; // in cents
      } else {
        kalshiOrderPayload.no_price = price;
      }
    }

    // Set time in force
    kalshiOrderPayload.time_in_force = timeInForce || "gtc";

    // Log order submission
    await logCompliance(supabase, null, "order_submitted", "info",
      `Submitting ${resolvedOrderType} order: ${action} ${contractCount}x ${side} ${resolvedTicker} @ ${price}c`,
      { payload: kalshiOrderPayload, liquidity_check: liquidityCheck }
    );

    // Place order on Kalshi
    const kalshiBase = getKalshiBaseUrl();
    const orderPath = "/trade-api/v2/portfolio/orders";
    const timestamp = Math.floor(Date.now() / 1000);
    const authHeaders = generateAuthHeaders(kalshiKeyId, kalshiPrivateKey, "POST", orderPath, timestamp);

    const kalshiResponse = await fetch(`${kalshiBase}/portfolio/orders`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(kalshiOrderPayload),
    });

    const kalshiResult = await kalshiResponse.json();

    if (!kalshiResponse.ok) {
      // Order rejected by Kalshi
      const { data: failedTrade } = await supabase.from("trades").insert({
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
        notes: `Kalshi rejected: ${kalshiResult.message || kalshiResult.error || JSON.stringify(kalshiResult)}`,
      }).select().single();

      await logCompliance(supabase, failedTrade?.id, "order_failed", "error",
        `Kalshi order rejected: ${kalshiResult.message || "Unknown error"}`,
        { kalshi_response: kalshiResult, payload: kalshiOrderPayload }
      );

      // Liquidity fallback: if rejected due to insufficient liquidity, try limit at worse price
      if (liquidityCheck.fallbackAction && !liquidityCheck.sufficient) {
        await logCompliance(supabase, failedTrade?.id, "liquidity_fallback", "warning",
          `Attempting liquidity fallback: ${liquidityCheck.fallbackAction}`,
          { original_price: price, ticker: resolvedTicker }
        );
      }

      return new Response(JSON.stringify({
        success: false,
        error: `Kalshi order rejected: ${kalshiResult.message || "Unknown error"}`,
        trade: failedTrade,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Order accepted
    const kalshiOrder = kalshiResult.order;
    const orderStatus = kalshiOrder.remaining_count === 0 ? "filled" :
                        kalshiOrder.remaining_count < contractCount ? "partial" : "open";

    const { data: trade, error: insertError } = await supabase.from("trades").insert({
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
      time_in_force: kalshiOrderPayload.time_in_force,
      filled_price: orderStatus === "filled" ? kalshiOrder.avg_price : null,
      filled_at: orderStatus === "filled" ? new Date().toISOString() : null,
      pnl: 0,
      notes: notes || `Live order on Kalshi: ${kalshiOrder.order_id}`,
    }).select().single();

    if (insertError) throw insertError;

    const eventType = orderStatus === "filled" ? "order_filled" : "order_submitted";
    await logCompliance(supabase, trade.id, eventType, "info",
      `Kalshi order ${kalshiOrder.order_id}: ${orderStatus} - ${action} ${contractCount}x ${side} ${resolvedTicker} @ ${price}c`,
      { order_id: kalshiOrder.order_id, kalshi_status: kalshiOrder.status, remaining: kalshiOrder.remaining_count }
    );

    // Update risk state
    await updateRiskState(supabase, 0);

    return new Response(JSON.stringify({
      success: true,
      trade,
      kalshiOrder,
      message: `Live trade ${orderStatus}: ${action.toUpperCase()} ${contractCount}x ${side.toUpperCase()} ${resolvedTicker} @ ${price}c`,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("execute-trade error:", e);

    // Log system error
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      await logCompliance(supabase, null, "system_event", "error",
        `Trade execution error: ${e instanceof Error ? e.message : "Unknown error"}`,
        { stack: e instanceof Error ? e.stack : undefined }
      );
    } catch {}

    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ─── Risk State Updates ──────────────────────────────────────

async function updateRiskState(supabase: any, pnlChange: number) {
  const today = new Date().toISOString().split("T")[0];

  // Get current risk state
  const { data: current } = await supabase
    .from("risk_state")
    .select("*")
    .eq("date", today)
    .single();

  if (current) {
    await supabase.from("risk_state").update({
      daily_pnl: current.daily_pnl + pnlChange,
      daily_trades: current.daily_trades + 1,
      max_drawdown_today: Math.min(current.max_drawdown_today, current.daily_pnl + pnlChange),
      updated_at: new Date().toISOString(),
    }).eq("date", today);
  } else {
    await supabase.from("risk_state").insert({
      date: today,
      daily_pnl: pnlChange,
      daily_trades: 1,
      max_drawdown_today: Math.min(0, pnlChange),
    });
  }
}
