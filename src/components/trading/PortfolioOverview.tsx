import { TrendingUp, TrendingDown, DollarSign, BarChart3, Target, Clock, Loader2, Wallet, ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string)?.trim();
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string)?.trim();

async function fetchKalshiBalance(): Promise<number | null> {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/functions/v1/kalshi-proxy?endpoint=portfolio/balance`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    // Kalshi returns balance in cents
    if (typeof data?.balance === "number") return data.balance / 100;
    return null;
  } catch {
    return null;
  }
}

// Fallback if strategies table can't be reached — matches onboarding seed (S-001: $500, S-002: $1k, S-005: $1k)
const PAPER_STARTING_BALANCE = 2_500;

interface Position {
  market_id: string;
  ticker: string | null;
  market_question: string;
  side: string;
  action: string;
  price: number;
  amount: number;
  pnl: number | null;
  strategy: string | null;
  filled_price: number | null;
  created_at: string | null;
  filled_at: string | null;
  status: string;
}

interface Stats {
  portfolioValue: number;
  cashAvailable: number;
  totalPnl: number;
  winRate: number;
  openPositionCount: number;
  totalTrades: number;
}

// ─── Stat cards ───────────────────────────────────────────────────────────────
// mode: 'paper' | 'live' | undefined (all)
export function PortfolioStats({
  mode,
  startingBalance: startingBalanceProp,
}: {
  mode?: "paper" | "live";
  startingBalance?: number;
}) {
  const effectiveStartingBalance = startingBalanceProp ?? PAPER_STARTING_BALANCE;
  const [stats, setStats] = useState<Stats>({
    portfolioValue: 0, cashAvailable: 0, totalPnl: 0,
    winRate: 0, openPositionCount: 0, totalTrades: 0,
  });
  const [loading, setLoading] = useState(true);
  const initialized = useRef(false);

  const load = useCallback(async () => {
    if (!initialized.current) setLoading(true);

    const MAY_START = "2026-04-22T00:00:00.000Z";

    // PnL only comes from settled trades — filled trades have pnl=0 until Kalshi resolves
    let settledQuery = supabase
      .from("trades").select("pnl, mode").eq("status", "settled").gte("settled_at", MAY_START);
    // Open positions: placed but not yet resolved
    let openQuery = supabase
      .from("trades").select("amount, mode").eq("status", "filled").is("settled_at", null);
    // Starting balance from strategies table
    const strategiesQuery = supabase
      .from("strategies").select("starting_balance");

    if (mode) {
      settledQuery = settledQuery.eq("mode", mode);
      openQuery = openQuery.eq("mode", mode);
    }

    const [{ data: settledTrades }, { data: openPositions }, { data: strategyRows }] = await Promise.all([
      settledQuery,
      openQuery,
      strategiesQuery,
    ]);

    const startingBalance = strategyRows
      ? strategyRows.reduce((s, r) => s + (r.starting_balance ?? 0), 0)
      : effectiveStartingBalance;

    const totalPnl = (settledTrades ?? []).reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winners = (settledTrades ?? []).filter(t => (t.pnl || 0) > 0).length;
    const losers = (settledTrades ?? []).filter(t => (t.pnl || 0) < 0).length;
    const capitalInFlight = (openPositions ?? []).reduce((s, t) => s + (t.amount || 0), 0);

    let portfolioValue: number;
    let cashAvailable: number;

    if (mode === "paper" || !mode) {
      // Paper: starting capital + settled P&L. Cash available = that minus what's currently in flight.
      portfolioValue = startingBalance + totalPnl;
      cashAvailable = Math.max(0, portfolioValue - capitalInFlight);
    } else {
      // Live: fetch real balance from Kalshi; fall back to trade math if API unavailable
      const kalshiBalance = await fetchKalshiBalance();
      if (kalshiBalance !== null) {
        cashAvailable = kalshiBalance;
        portfolioValue = kalshiBalance + totalPnl;
      } else {
        portfolioValue = startingBalance + totalPnl;
        cashAvailable = Math.max(0, portfolioValue - capitalInFlight);
      }
    }

    setStats({
      portfolioValue,
      cashAvailable,
      totalPnl,
      winRate: winners + losers > 0 ? Math.round((winners / (winners + losers)) * 100) : 0,
      openPositionCount: (openPositions ?? []).length,
      totalTrades: (settledTrades ?? []).length,
    });
    setLoading(false);
    initialized.current = true;
  }, [mode]);

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`portfolio-stats-rt-${mode ?? "all"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, mode]);

  const pnlPercent = mode === "paper"
    ? ((stats.totalPnl / effectiveStartingBalance) * 100).toFixed(1)
    : stats.portfolioValue > 0
      ? ((stats.totalPnl / stats.portfolioValue) * 100).toFixed(1)
      : "0.0";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (mode === "paper") {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={Wallet}
          label="Portfolio Balance"
          value={`$${stats.portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          sub={`Started at $${effectiveStartingBalance.toLocaleString()}`}
        />
        <StatCard
          icon={stats.totalPnl >= 0 ? TrendingUp : TrendingDown}
          label="Total P&L"
          value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          valueClass={stats.totalPnl >= 0 ? "text-profit" : "text-loss"}
          sub={`${pnlPercent}%`}
        />
        <StatCard
          icon={Target}
          label="Win Rate"
          value={stats.totalTrades > 0 ? `${stats.winRate}%` : "--"}
          valueClass={stats.winRate >= 50 ? "text-profit" : "text-loss"}
        />
        <StatCard icon={BarChart3} label="Total Trades" value={`${stats.totalTrades}`} />
      </div>
    );
  }

  // Live / all-mode stat cards
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard
        icon={Wallet}
        label="Cash Balance"
        value={`$${stats.cashAvailable.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
        sub="Kalshi account"
      />
      <StatCard
        icon={stats.totalPnl >= 0 ? TrendingUp : TrendingDown}
        label="Total P&L"
        value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
        valueClass={stats.totalPnl >= 0 ? "text-profit" : "text-loss"}
        sub={`${pnlPercent}%`}
      />
      <StatCard
        icon={Target}
        label="Win Rate"
        value={stats.totalTrades > 0 ? `${stats.winRate}%` : "--"}
        valueClass={stats.winRate >= 50 ? "text-profit" : "text-loss"}
      />
      <StatCard icon={BarChart3} label="Open Positions" value={`${stats.openPositionCount}`} />
    </div>
  );
}

// ─── Active positions list ────────────────────────────────────────────────────
function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function PositionDetail({ pos, onClose }: { pos: Position; onClose: () => void }) {
  const entryTime = pos.filled_at || pos.created_at;
  const daysHeld = entryTime
    ? Math.floor((Date.now() - new Date(entryTime).getTime()) / 86_400_000)
    : null;

  return (
    <div className="mt-2 mb-1 rounded-xl bg-secondary/60 p-4 text-sm space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-foreground leading-snug">{pos.market_question}</p>
        <button onClick={onClose} className="shrink-0 text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <div>
          <p className="text-muted-foreground mb-0.5">Side</p>
          <p className={`font-medium ${pos.side?.toLowerCase() === "yes" ? "text-profit" : "text-loss"}`}>
            {pos.side?.toUpperCase()}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground mb-0.5">Entry price</p>
          <p className="font-medium tabular-nums">{pos.filled_price || pos.price}¢</p>
        </div>
        <div>
          <p className="text-muted-foreground mb-0.5">Amount</p>
          <p className="font-medium tabular-nums">${pos.amount.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-muted-foreground mb-0.5">Unrealized P&L</p>
          <p className={`font-medium tabular-nums ${(pos.pnl ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>
            {pos.pnl != null ? `${(pos.pnl ?? 0) >= 0 ? "+" : ""}$${(pos.pnl ?? 0).toFixed(2)}` : "—"}
          </p>
        </div>
        {pos.strategy && (
          <div>
            <p className="text-muted-foreground mb-0.5">Strategy</p>
            <p className="font-medium">{pos.strategy}</p>
          </div>
        )}
        {pos.ticker && (
          <div>
            <p className="text-muted-foreground mb-0.5">Ticker</p>
            <p className="font-medium font-mono text-[11px]">{pos.ticker}</p>
          </div>
        )}
        {entryTime && (
          <div>
            <p className="text-muted-foreground mb-0.5">Entered</p>
            <p className="font-medium">{timeAgo(entryTime)}</p>
          </div>
        )}
        {daysHeld !== null && (
          <div>
            <p className="text-muted-foreground mb-0.5">Days held</p>
            <p className="font-medium">{daysHeld === 0 ? "< 1 day" : `${daysHeld}d`}</p>
          </div>
        )}
      </div>
    </div>
  );
}

const PAGE_SIZE = 5;

export function PortfolioOverview({ mode }: { mode?: "paper" | "live" }) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const initialized = useRef(false);

  const load = useCallback(async () => {
    if (!initialized.current) setLoading(true);
    let q = supabase
      .from("trades")
      .select("*")
      .eq("status", "filled")
      .eq("action", "buy")
      .order("created_at", { ascending: false })
      .limit(100);
    if (mode) q = q.eq("mode", mode);
    const { data } = await q;
    setPositions((data ?? []) as Position[]);
    setLoading(false);
    initialized.current = true;
  }, [mode]);

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`portfolio-positions-rt-${mode ?? "all"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, mode]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const visible = expanded ? positions : positions.slice(0, PAGE_SIZE);
  const hiddenCount = positions.length - PAGE_SIZE;

  return (
    <div className="rounded-2xl bg-card apple-shadow">
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">
              {mode === "paper" ? "Open Positions" : "Active Positions"}
            </h3>
          </div>
          {positions.length > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">{positions.length} total</span>
          )}
        </div>

        {positions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {mode === "paper"
              ? "No open positions. The agent will enter positions during the next scan cycle."
              : "No open positions. Use the Live Agent to start trading."}
          </p>
        ) : (
          <div>
            {visible.map((pos, i) => {
              const id = `${pos.market_id}-${i}`;
              const isSelected = selectedId === id;
              return (
                <div key={id} className="border-b border-border last:border-0">
                  <button
                    onClick={() => setSelectedId(isSelected ? null : id)}
                    className="w-full flex items-start justify-between py-3.5 text-left hover:bg-secondary/30 -mx-1 px-1 rounded-lg transition-colors"
                  >
                    <div className="flex-1 pr-3 min-w-0">
                      <p className="text-sm font-medium text-foreground line-clamp-2">{pos.market_question}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {pos.side?.toUpperCase()} @ {pos.filled_price || pos.price}¢ · ${pos.amount}
                        {pos.strategy && <span> · {pos.strategy}</span>}
                      </p>
                    </div>
                    <div className="text-right shrink-0 flex flex-col items-end gap-1">
                      {pos.pnl !== null && pos.pnl !== 0 && (
                        <p className={`text-sm font-medium tabular-nums ${(pos.pnl ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>
                          {(pos.pnl ?? 0) >= 0 ? "+" : ""}${(pos.pnl ?? 0).toFixed(2)}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground tabular-nums">${pos.amount.toFixed(2)}</p>
                    </div>
                  </button>
                  {isSelected && (
                    <PositionDetail pos={pos} onClose={() => setSelectedId(null)} />
                  )}
                </div>
              );
            })}

            {hiddenCount > 0 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {expanded ? (
                  <><ChevronUp className="h-3.5 w-3.5" /> Show less</>
                ) : (
                  <><ChevronDown className="h-3.5 w-3.5" /> Show {hiddenCount} more</>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, valueClass = "text-foreground", sub }: {
  icon: React.ElementType; label: string; value: string; valueClass?: string; sub?: string;
}) {
  return (
    <div className="rounded-2xl bg-card p-4 sm:p-5 apple-shadow transition-shadow duration-300 hover:apple-shadow-hover">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-xl font-medium tabular-nums ${valueClass}`}>{value}</p>
      {sub && <p className={`text-sm text-muted-foreground mt-0.5`}>{sub}</p>}
    </div>
  );
}
