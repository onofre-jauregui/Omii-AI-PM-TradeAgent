import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Trophy, Calendar, BarChart3, TrendingUp, Activity, Wallet } from "lucide-react";
import { useState } from "react";

export function ProfilePanel() {
  const [profile, setProfile] = useState({
    displayName: "Anon Trader",
    email: "",
    walletAddress: "",
  });

  const stats = {
    totalTrades: 142,
    winRate: 68,
    totalPnl: 4250,
    avgReturn: 12.4,
    activeSince: "Jan 2026",
    bestTrade: 840,
    worstTrade: -320,
    sharpeRatio: 1.85,
  };

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="grid md:grid-cols-3 gap-6">
        {/* Profile Info */}
        <Card className="bg-card border-border md:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
              <User className="h-4 w-4" /> PROFILE
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col items-center gap-3">
              <Avatar className="h-20 w-20 border-2 border-primary/50">
                <AvatarFallback className="bg-primary/10 text-primary font-mono text-xl">
                  {profile.displayName.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="font-mono font-bold text-foreground">{profile.displayName}</p>
                <p className="text-xs font-mono text-muted-foreground">Active since {stats.activeSince}</p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-mono text-muted-foreground">DISPLAY NAME</Label>
                <Input
                  value={profile.displayName}
                  onChange={(e) => setProfile(prev => ({ ...prev, displayName: e.target.value }))}
                  className="bg-secondary border-border font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-mono text-muted-foreground">EMAIL</Label>
                <Input
                  value={profile.email}
                  onChange={(e) => setProfile(prev => ({ ...prev, email: e.target.value }))}
                  placeholder="trader@example.com"
                  className="bg-secondary border-border font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-mono text-muted-foreground">WALLET ADDRESS</Label>
                <Input
                  value={profile.walletAddress}
                  onChange={(e) => setProfile(prev => ({ ...prev, walletAddress: e.target.value }))}
                  placeholder="0x..."
                  className="bg-secondary border-border font-mono text-sm"
                />
              </div>
              <Button className="w-full font-mono text-xs gap-2">
                <Wallet className="h-4 w-4" /> SAVE PROFILE
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Trading Stats */}
        <Card className="bg-card border-border md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
              <Trophy className="h-4 w-4" /> TRADING STATISTICS
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { icon: BarChart3, label: "TOTAL TRADES", value: stats.totalTrades.toString() },
                { icon: TrendingUp, label: "WIN RATE", value: `${stats.winRate}%`, color: "text-profit" },
                { icon: Activity, label: "TOTAL P&L", value: `+$${stats.totalPnl.toLocaleString()}`, color: "text-profit" },
                { icon: TrendingUp, label: "AVG RETURN", value: `${stats.avgReturn}%`, color: "text-profit" },
                { icon: Trophy, label: "BEST TRADE", value: `+$${stats.bestTrade}`, color: "text-profit" },
                { icon: Activity, label: "WORST TRADE", value: `-$${Math.abs(stats.worstTrade)}`, color: "text-loss" },
                { icon: BarChart3, label: "SHARPE RATIO", value: stats.sharpeRatio.toFixed(2) },
                { icon: Calendar, label: "ACTIVE SINCE", value: stats.activeSince },
              ].map((stat, i) => (
                <div key={i} className="p-3 rounded-md bg-secondary/50 border border-border">
                  <div className="flex items-center gap-1.5 mb-1">
                    <stat.icon className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[10px] font-mono text-muted-foreground tracking-wider">{stat.label}</span>
                  </div>
                  <p className={`text-sm font-mono font-bold ${stat.color || "text-foreground"}`}>{stat.value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
