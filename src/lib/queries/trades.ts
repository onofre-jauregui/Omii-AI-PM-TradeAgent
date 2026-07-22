/**
 * Shared React Query hooks for the `trades` table.
 *
 * Before this, five permanently-mounted dashboard components each fetched
 * `trades` independently (~8-12 reads on first paint, three of them the same
 * settled-trades scan) and each ran its own realtime channel. These hooks give
 * every consumer ONE cached, deduped, stale-while-revalidate source. A single
 * realtime channel (in strategiesContext) invalidates these keys on change.
 *
 * Query keys are namespaced under ["trades", ...] so one
 * `invalidateQueries({ queryKey: ["trades"] })` refreshes every consumer.
 */
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const MAY_START = "2026-04-22T00:00:00.000Z";

export const tradesKeys = {
  all: ["trades"] as const,
  settled: () => ["trades", "settled"] as const,
  open: (mode?: string) => ["trades", "open", mode ?? "all"] as const,
  recent: (mode?: string) => ["trades", "recent", mode ?? "all"] as const,
};

async function currentUserId(): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? "";
}

export interface SettledTradeRow {
  strategy: string | null;
  strategy_id: string | null;
  pnl: number | null;
  status: string;
  amount: number;
  settled_at: string | null;
  mode: string;
  ticker: string | null;
}

/**
 * Canonical settled-trades read. Not mode-filtered — one cache serves both
 * paper and live tabs, and consumers filter client-side. Superset of columns
 * needed by every settled-trades consumer (DashboardHero via Tier 2 RPC later,
 * StrategyPerformance, strategiesContext).
 */
export async function fetchSettledTrades(): Promise<SettledTradeRow[]> {
  const userId = await currentUserId();
  const { data } = await supabase
    .from("trades")
    .select("strategy, strategy_id, pnl, status, amount, settled_at, mode, ticker")
    .eq("status", "settled")
    .eq("user_id", userId)
    .gte("settled_at", MAY_START)
    .order("settled_at", { ascending: false })
    .limit(5000);
  return (data as SettledTradeRow[]) ?? [];
}

export function useSettledTrades() {
  return useQuery({
    queryKey: tradesKeys.settled(),
    queryFn: fetchSettledTrades,
    placeholderData: keepPreviousData,
  });
}

/** Open/active positions for the positions panel (mode-scoped). */
export function useOpenPositions(mode?: "paper" | "live") {
  return useQuery({
    queryKey: tradesKeys.open(mode),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const userId = await currentUserId();
      let q = supabase
        .from("trades")
        .select("*")
        .eq("action", "buy")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100);
      // Live surfaces resting orders (open/partial) too; paper is always filled.
      q = mode === "live"
        ? q.in("status", ["filled", "open", "partial"])
        : q.eq("status", "filled");
      if (mode) q = q.eq("mode", mode);
      const { data } = await q;
      return (data ?? []) as unknown[];
    },
  });
}

/** Recent trade history for the log (mode-scoped, newest 50). */
export function useRecentTrades(mode?: "paper" | "live") {
  return useQuery({
    queryKey: tradesKeys.recent(mode),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const userId = await currentUserId();
      let q = supabase
        .from("trades")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (mode) q = q.eq("mode", mode);
      const { data } = await q;
      return (data ?? []) as unknown[];
    },
  });
}
