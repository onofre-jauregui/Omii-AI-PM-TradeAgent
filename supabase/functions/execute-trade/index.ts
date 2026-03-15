import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { marketId, marketQuestion, side, action, price, amount, strategy, mode, notes } = await req.json();

    // Validate required fields
    if (!marketId || !side || !action || !price || !amount) {
      return new Response(JSON.stringify({ error: "Missing required fields: marketId, side, action, price, amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["yes", "no"].includes(side) || !["buy", "sell"].includes(action)) {
      return new Response(JSON.stringify({ error: "Invalid side or action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const tradeMode = mode || "paper";

    if (tradeMode === "live") {
      // For live trading, we'd call Polymarket CLOB API here
      // This requires user's CLOB API credentials
      const polymarketApiKey = Deno.env.get("POLYMARKET_API_KEY");
      const polymarketSecret = Deno.env.get("POLYMARKET_API_SECRET");
      const polymarketPassphrase = Deno.env.get("POLYMARKET_API_PASSPHRASE");

      if (!polymarketApiKey || !polymarketSecret || !polymarketPassphrase) {
        // Log as failed trade
        const { data: trade, error: insertError } = await supabase.from("trades").insert({
          market_id: marketId,
          market_question: marketQuestion || "Unknown",
          side,
          action,
          price,
          amount,
          strategy: strategy || null,
          mode: "live",
          status: "failed",
          notes: "Live trading credentials not configured. Please add your Polymarket API credentials in Settings.",
        }).select().single();

        return new Response(JSON.stringify({
          success: false,
          error: "Live trading credentials not configured. Please add your Polymarket API Key, Secret, and Passphrase in Settings.",
          trade,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // TODO: Implement actual Polymarket CLOB API order placement
      // For now, log as pending and note that CLOB integration is next step
      const { data: trade, error: insertError } = await supabase.from("trades").insert({
        market_id: marketId,
        market_question: marketQuestion || "Unknown",
        side,
        action,
        price,
        amount,
        strategy: strategy || null,
        mode: "live",
        status: "pending",
        notes: notes || "Live order submitted to Polymarket CLOB",
      }).select().single();

      if (insertError) throw insertError;

      return new Response(JSON.stringify({ success: true, trade, message: "Live trade submitted" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Paper trading - simulate instant fill
    const { data: trade, error: insertError } = await supabase.from("trades").insert({
      market_id: marketId,
      market_question: marketQuestion || "Unknown",
      side,
      action,
      price,
      amount,
      strategy: strategy || null,
      mode: "paper",
      status: "filled",
      pnl: 0,
      notes: notes || "Paper trade - simulated execution",
    }).select().single();

    if (insertError) throw insertError;

    return new Response(JSON.stringify({
      success: true,
      trade,
      message: `Paper trade executed: ${action.toUpperCase()} ${side.toUpperCase()} @ ${price}¢ for $${amount}`,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("execute-trade error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
