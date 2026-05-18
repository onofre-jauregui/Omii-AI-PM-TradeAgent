import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: trades, error } = await supabase
      .from("trades")
      .select("ticker, side, amount, pnl, settled_at, created_at")
      .eq("status", "settled")
      .gt("created_at", "2026-04-22T00:00:00.000Z")
      .order("settled_at", { ascending: true });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rows = trades ?? [];

    // Aggregate stats
    const tradeCount = rows.length;
    const wins = rows.filter((t: any) => (t.pnl ?? 0) > 0).length;
    const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
    const totalPnl = rows.reduce((sum: number, t: any) => sum + (t.pnl ?? 0), 0);

    // Build daily cumulative P&L from settled_at date
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

    // Last 3 settled trades (most recent first)
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
