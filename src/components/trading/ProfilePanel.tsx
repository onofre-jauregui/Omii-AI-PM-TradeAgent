import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Trophy, Calendar, BarChart3, TrendingUp, Activity, Wallet } from "lucide-react";
import { useState } from "react";

export function ProfilePanel() {
  const [profile, setProfile] = useState({
    displayName: "Anon Trader", email: "", walletAddress: "",
  });

  const stats = {
    totalTrades: 142, winRate: 68, totalPnl: 4250, avgReturn: 12.4,
    activeSince: "Jan 2026", bestTrade: 840, worstTrade: -320, sharpeRatio: 1.85,
  };

  return (
    <div className="space-y-8 apple-reveal">
      <div>
        <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>Profile</h2>
        <p className="text-sm text-muted-foreground mt-1">Your trading identity and performance.</p>
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
              <Label className="text-sm text-muted-foreground">Wallet Address</Label>
              <Input value={profile.walletAddress} onChange={(e) => setProfile(prev => ({ ...prev, walletAddress: e.target.value }))} placeholder="0x..." className="rounded-xl border-0 bg-secondary text-sm" />
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
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { icon: BarChart3, label: "Total Trades", value: stats.totalTrades.toString() },
              { icon: TrendingUp, label: "Win Rate", value: `${stats.winRate}%`, color: "text-profit" },
              { icon: Activity, label: "Total P&L", value: `+$${stats.totalPnl.toLocaleString()}`, color: "text-profit" },
              { icon: TrendingUp, label: "Avg Return", value: `${stats.avgReturn}%`, color: "text-profit" },
              { icon: Trophy, label: "Best Trade", value: `+$${stats.bestTrade}`, color: "text-profit" },
              { icon: Activity, label: "Worst Trade", value: `-$${Math.abs(stats.worstTrade)}`, color: "text-loss" },
              { icon: BarChart3, label: "Sharpe Ratio", value: stats.sharpeRatio.toFixed(2) },
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
