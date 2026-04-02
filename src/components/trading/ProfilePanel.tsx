import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Trophy, Calendar, BarChart3, TrendingUp, Activity, Wallet, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export function ProfilePanel() {
  const [profile, setProfile] = useState({
    displayName: "Anon Trader", email: "", walletAddress: "",
  });

  const [stats, setStats] = useState({
    totalTrades: 0, winRate: 0, totalPnl: 0, avgReturn: 0,
    activeSince: "--", bestTrade: 0, worstTrade: 0, sharpeRatio: 0,
  });
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setLoading(true);

    const { data: trades } = await supabase
      .from("trades")
      .select("pnl, amount, price, created_at, status")
      .eq("status", "filled")
      .order("created_at", { ascending: true });

    if (trades && trades.length > 0) {
      const pnls = trades.map(t => t.pnl || 0);
      const totalPnl = pnls.reduce((s, p) => s + p, 0);
      const winners = pnls.filter(p => p > 0).length;
      const losers = pnls.filter(p => p < 0).length;
      const totalWithPnl = winners + losers;
      const avgReturn = totalWithPnl > 0 ? totalPnl / totalWithPnl : 0;

      // Simple Sharpe approximation
      const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length;
      const variance = pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pnls.length;
      const stdDev = Math.sqrt(variance);
      const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

      const firstTradeDate = new Date(trades[0].created_at);

      setStats({
        totalTrades: trades.length,
        winRate: totalWithPnl > 0 ? Math.round((winners / totalWithPnl) * 100) : 0,
        totalPnl: Math.round(totalPnl),
        avgReturn: Math.round(avgReturn * 100) / 100,
        activeSince: firstTradeDate.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        bestTrade: Math.round(Math.max(...pnls, 0)),
        worstTrade: Math.round(Math.min(...pnls, 0)),
        sharpeRatio: Math.round(sharpe * 100) / 100,
      });
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return (
    <div className="space-y-8 apple-reveal">
      <div>
        <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>Profile</h2>
        <p className="text-sm text-muted-foreground mt-1">Your trading identity and performance on Kalshi.</p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="rounded-2xl bg-card p-6 apple-shadow md:col-span-1 space-y-6">
          <div className="flex flex-col items-center gap-3">
            <Avatar className="h-20 w-20">
              <AvatarFallback className="bg-secondary text-foreground text-xl font-light">
                {profile.displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="text-center">
              <p className="font-medium text-foreground">{profile.displayName}</p>
              <p className="text-xs text-muted-foreground">Active since {stats.activeSince}</p>
            </div>
          </div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Display Name</Label>
              <Input value={profile.displayName} onChange={(e) => setProfile(prev => ({ ...prev, displayName: e.target.value }))} className="rounded-xl border-0 bg-secondary text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Email</Label>
              <Input value={profile.email} onChange={(e) => setProfile(prev => ({ ...prev, email: e.target.value }))} placeholder="trader@example.com" className="rounded-xl border-0 bg-secondary text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Kalshi Username</Label>
              <Input value={profile.walletAddress} onChange={(e) => setProfile(prev => ({ ...prev, walletAddress: e.target.value }))} placeholder="your-kalshi-username" className="rounded-xl border-0 bg-secondary text-sm" />
            </div>
            <Button className="w-full rounded-full gap-2 text-sm">
              <Wallet className="h-4 w-4" /> Save Profile
            </Button>
          </div>
        </div>

        <div className="rounded-2xl bg-card p-6 apple-shadow md:col-span-2">
          <div className="flex items-center gap-2 mb-5">
            <Trophy className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Trading Statistics</h3>
            {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { icon: BarChart3, label: "Total Trades", value: stats.totalTrades.toString() },
              { icon: TrendingUp, label: "Win Rate", value: stats.totalTrades > 0 ? `${stats.winRate}%` : "--", color: stats.winRate >= 50 ? "text-profit" : "text-loss" },
              { icon: Activity, label: "Total P&L", value: stats.totalPnl !== 0 ? `${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toLocaleString()}` : "--", color: stats.totalPnl >= 0 ? "text-profit" : "text-loss" },
              { icon: TrendingUp, label: "Avg Return", value: stats.avgReturn !== 0 ? `$${stats.avgReturn}` : "--", color: stats.avgReturn >= 0 ? "text-profit" : "text-loss" },
              { icon: Trophy, label: "Best Trade", value: stats.bestTrade > 0 ? `+$${stats.bestTrade}` : "--", color: "text-profit" },
              { icon: Activity, label: "Worst Trade", value: stats.worstTrade < 0 ? `-$${Math.abs(stats.worstTrade)}` : "--", color: "text-loss" },
              { icon: BarChart3, label: "Sharpe Ratio", value: stats.sharpeRatio !== 0 ? stats.sharpeRatio.toFixed(2) : "--" },
              { icon: Calendar, label: "Active Since", value: stats.activeSince },
            ].map((stat, i) => (
              <div key={i} className="rounded-xl bg-secondary p-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <stat.icon className="h-3 w-3 text-muted-foreground" />
                  <span className="text-[10px] text-muted-foreground">{stat.label}</span>
                </div>
                <p className={`text-sm font-medium tabular-nums ${stat.color || "text-foreground"}`}>{stat.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
