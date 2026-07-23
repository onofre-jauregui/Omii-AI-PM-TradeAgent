/**
 * Portfolio hooks backed by the server-side aggregate RPCs (Tier 2).
 *
 * The dashboard hero used to pull up to 2,000 raw settled rows and reduce them
 * in JS on every mode switch. These read one summary row + ~60 daily buckets
 * from `get_portfolio_summary` / `get_equity_curve`, which aggregate in SQL over
 * the composite index. Keys are mode-scoped and deliberately do NOT use
 * keepPreviousData — a mode switch must show the target mode's cached data (or a
 * brief skeleton), never the other mode's numbers.
 */
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PortfolioSummary {
  startingBalance: number;
  totalPnl: number;
  todayPnl: number;
  settledCount: number;
  winners: number;
  losers: number;
  openPositions: number;
  tradesToday: number;
  lastSettledAt: string | null;
}

export function usePortfolioSummary(mode?: "paper" | "live") {
  return useQuery({
    queryKey: ["portfolio", "summary", mode ?? "all"],
    queryFn: async (): Promise<PortfolioSummary | null> => {
      // Local midnight — matches the browser's old "today" boundary exactly.
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const { data, error } = await supabase.rpc("get_portfolio_summary", {
        p_mode: mode ?? null,
        p_today_start: todayStart.toISOString(),
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (!row) return null;
      const n = (v: unknown) => Number(v ?? 0);
      return {
        startingBalance: n(row.starting_balance),
        totalPnl: n(row.total_pnl),
        todayPnl: n(row.today_pnl),
        settledCount: n(row.settled_count),
        winners: n(row.winners),
        losers: n(row.losers),
        openPositions: n(row.open_positions),
        tradesToday: n(row.trades_today),
        lastSettledAt: (row.last_settled_at as string) ?? null,
      };
    },
  });
}

export interface EquityDay { day: string; dayPnl: number; }

export function useEquityCurve(mode?: "paper" | "live") {
  return useQuery({
    queryKey: ["portfolio", "equity", mode ?? "all"],
    queryFn: async (): Promise<EquityDay[]> => {
      const { data, error } = await supabase.rpc("get_equity_curve", { p_mode: mode ?? null });
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
        day: String(r.day),
        dayPnl: Number(r.day_pnl ?? 0),
      }));
    },
  });
}

/**
 * Live Kalshi wallet balance (live mode only). staleTime throttles the ping to
 * ~15s; on a transient failure React Query keeps the last successful value in
 * `data`, so the displayed balance never drops to null after a good read.
 */
export function useKalshiWallet(mode?: "paper" | "live") {
  return useQuery({
    queryKey: ["kalshi", "wallet"],
    enabled: mode === "live",
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<number | null> => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return null;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kalshi-ping`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
      if (!r.ok) throw new Error("kalshi-ping failed");
      const j = await r.json();
      return j?.balance_usd != null ? Number(j.balance_usd) : null;
    },
  });
}
