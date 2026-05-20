import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Public landing page stats are scoped to the founding account — single verified track record.
const CANONICAL_USER_ID = "ea207ba1-b7a9-4a7b-96bc-922e922d627d";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Starting balance from ALL strategies — include inactive ones whose trades still count
    const { data: strategies } = await supabase
      .from("strategies")
      .select("starting_balance")
      .eq("user_id", CANONICAL_USER_ID);

    const startingBalance = (strategies ?? []).reduce(
      (sum: number, s: any) => sum + (s.starting_balance ?? 0),
      0
    ) || 2500; // fallback if no strategies yet

    // May 1 cutoff matches dashboard — excludes pre-calibration development trades
    const MAY_START = "2026-05-01T00:00:00.000Z";

    const { data: trades, error } = await supabase
      .from("trades")
      .select("ticker, side, amount, pnl, settled_at, created_at")
      .eq("status", "settled")
      .eq("user_id", CANONICAL_USER_ID)
      .gte("settled_at", MAY_START)
      .order("settled_at", { ascending: true });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rows = trades ?? [];

    const tradeCount = rows.length;
    const wins = rows.filter((t: any) => (t.pnl ?? 0) > 0).length;
    const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
    const totalPnl = rows.reduce((sum: number, t: any) => sum + (t.pnl ?? 0), 0);

    // Daily cumulative P&L bucketed by settled_at date
    const dailyMap: Record<string, number> = {};
    for (const t of rows) {
      const dateStr = (t.settled_at ?? t.created_at ?? "").slice(0, 10);
      if (!dateStr) continue;
      dailyMap[dateStr] = (dailyMap[dateStr] ?? 0) + (t.pnl ?? 0);
    }

    const sortedDates = Object.keys(dailyMap).sort();
    let cumulative = 0;
    const dailyCumulative = sortedDates.map((date) => {
      cumulative += dailyMap[date];
      return { date, cumPnl: Math.round(cumulative * 100) / 100 };
    });

    const startDate = sortedDates[0] ?? "2026-04-23";

    const recent = [...rows]
      .reverse()
      .slice(0, 3)
      .map((t: any) => ({
        ticker: t.ticker ?? "",
        side: (t.side ?? "").toUpperCase(),
        amount: t.amount ?? 0,
        pnl: Math.round((t.pnl ?? 0) * 100) / 100,
      }));

    return new Response(
      JSON.stringify({
        totalPnl: Math.round(totalPnl * 100) / 100,
        winRate: Math.round(winRate * 10) / 10,
        tradeCount,
        startDate,
        startingBalance,
        dailyCumulative,
        recentTrades: recent,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("platform-stats error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
