import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Trophy, Calendar, BarChart3, TrendingUp, Activity, Wallet, Loader2, Zap, Camera, AlertCircle } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AvatarCropModal } from "./AvatarCropModal";

export function ProfilePanel() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState({
    displayName: "Anon Trader", email: "", walletAddress: "", avatarUrl: "",
  });
  const [subscription, setSubscription] = useState<{ tier: string; status: string } | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [stats, setStats] = useState({
    totalTrades: 0, winRate: 0, totalPnl: 0, avgReturn: 0,
    activeSince: "--", bestTrade: 0, worstTrade: 0, sharpeRatio: 0,
  });
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();

    const { data: trades } = await supabase
      .from("trades")
      .select("pnl, amount, price, created_at, status")
      .order("created_at", { ascending: true });

    if (trades && trades.length > 0) {
      const pnls = trades.map(t => t.pnl || 0);
      const totalPnl = pnls.reduce((s, p) => s + p, 0);
      const winners = pnls.filter(p => p > 0).length;
      const losers = pnls.filter(p => p < 0).length;
      const totalWithPnl = winners + losers;
      const avgReturn = totalWithPnl > 0 ? totalPnl / totalWithPnl : 0;
      const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length;
      const variance = pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pnls.length;
      const stdDev = Math.sqrt(variance);
      const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

      setStats({
        totalTrades: trades.length,
        winRate: totalWithPnl > 0 ? Math.round((winners / totalWithPnl) * 100) : 0,
        totalPnl: Math.round(totalPnl),
        avgReturn: Math.round(avgReturn * 100) / 100,
        activeSince: new Date(trades[0].created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        bestTrade: Math.round(Math.max(...pnls, 0)),
        worstTrade: Math.round(Math.min(...pnls, 0)),
        sharpeRatio: Math.round(sharpe * 100) / 100,
      });
    }

    if (user) {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("tier, status")
        .eq("user_id", user.id)
        .maybeSingle();
      setSubscription(sub ?? { tier: "free", status: "inactive" });

      const { data: prof } = await supabase
        .from("profiles")
        .select("display_name, avatar_url")
        .eq("id", user.id)
        .maybeSingle();

      setProfile(prev => ({
        ...prev,
        email: user.email ?? "",
        displayName: prof?.display_name ?? prev.displayName,
        avatarUrl: prof?.avatar_url ?? "",
      }));
    }

    setLoading(false);
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  // Step 1: file selected → open crop modal
  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    const objectUrl = URL.createObjectURL(file);
    setCropSrc(objectUrl);
    e.target.value = "";
  };

  // Step 2: crop confirmed → upload blob
  const handleCropConfirm = async (blob: Blob) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    setUploadingAvatar(true);
    setUploadError(null);
    const path = `${user.id}/avatar.jpg`;

    const { error: uploadErr } = await supabase.storage
      .from("avatars")
      .upload(path, blob, { upsert: true, contentType: "image/jpeg" });

    if (uploadErr) {
      setUploadError(uploadErr.message);
    } else {
      // Bust the cache by appending a timestamp so the browser re-fetches
      const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(path);
      const bustedUrl = `${publicUrl}?t=${Date.now()}`;
      await supabase.from("profiles").update({ avatar_url: bustedUrl }).eq("id", user.id);
      setProfile(prev => ({ ...prev, avatarUrl: bustedUrl }));
    }

    setUploadingAvatar(false);
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  };

  const handleCropCancel = () => {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  };

  const handleSaveProfile = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setSaving(true);
    await supabase.from("profiles").update({
      display_name: profile.displayName,
      updated_at: new Date().toISOString(),
    }).eq("id", user.id);
    setSaving(false);
  };

  const tierLabel = (tier: string) => {
    const labels: Record<string, string> = { free: "Free Trial", starter: "Starter", pro: "Pro", prop: "Prop" };
    return labels[tier] ?? tier;
  };

  return (
    <>
    {cropSrc && (
      <AvatarCropModal
        imageSrc={cropSrc}
        onConfirm={handleCropConfirm}
        onCancel={handleCropCancel}
      />
    )}
    <div className="space-y-6 apple-reveal">
      <div className="grid md:grid-cols-3 gap-6">
        {/* Avatar + identity card */}
        <div className="rounded-2xl bg-card p-6 apple-shadow md:col-span-1 space-y-5">
          {/* Clickable avatar */}
          <div className="flex flex-col items-center gap-3">
            <button
              className="relative group"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
              title="Upload photo"
            >
              <Avatar className="h-20 w-20">
                {profile.avatarUrl && <AvatarImage src={profile.avatarUrl} alt="Avatar" />}
                <AvatarFallback className="bg-secondary text-foreground text-xl font-light">
                  {profile.displayName.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                {uploadingAvatar
                  ? <Loader2 className="h-5 w-5 text-white animate-spin" />
                  : <Camera className="h-5 w-5 text-white" />}
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileSelected}
            />
            {uploadError && (
              <div className="flex items-center gap-1.5 text-[11px] text-loss">
                <AlertCircle className="h-3 w-3 shrink-0" />
                <span>Upload failed: {uploadError}</span>
              </div>
            )}
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
              <Input value={profile.email} disabled className="rounded-xl border-0 bg-secondary text-sm opacity-60" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Kalshi Username</Label>
              <Input value={profile.walletAddress} onChange={(e) => setProfile(prev => ({ ...prev, walletAddress: e.target.value }))} placeholder="your-kalshi-username" className="rounded-xl border-0 bg-secondary text-sm" />
            </div>
            <Button className="w-full rounded-full gap-2 text-sm" onClick={handleSaveProfile} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
              {saving ? "Saving…" : "Save Profile"}
            </Button>
          </div>

          {/* Subscription tier */}
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">Plan</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                subscription?.tier === "prop"    ? "bg-amber-500/10 text-amber-500" :
                subscription?.tier === "pro"     ? "bg-primary/10 text-primary" :
                subscription?.tier === "starter" ? "bg-emerald-500/10 text-emerald-500" :
                "bg-secondary text-muted-foreground"
              }`}>
                {tierLabel(subscription?.tier ?? "free")}
              </span>
            </div>
            {(!subscription || subscription.tier === "free" || subscription.status !== "active") && (
              <Button variant="outline" size="sm" className="w-full rounded-full gap-1.5 text-xs mt-1" onClick={() => navigate("/billing")}>
                <Zap className="h-3 w-3" /> Upgrade plan
              </Button>
            )}
          </div>
        </div>

        {/* Trading stats */}
        <div className="rounded-2xl bg-card p-6 apple-shadow md:col-span-2">
          <div className="flex items-center gap-2 mb-5">
            <Trophy className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Trading Statistics</h3>
            {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { icon: BarChart3,  label: "Total Trades", value: stats.totalTrades.toString() },
              { icon: TrendingUp, label: "Win Rate",     value: stats.totalTrades > 0 ? `${stats.winRate}%` : "--",     color: stats.winRate >= 50 ? "text-profit" : "text-loss" },
              { icon: Activity,   label: "Total P&L",    value: stats.totalPnl !== 0 ? `${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toLocaleString()}` : "--", color: stats.totalPnl >= 0 ? "text-profit" : "text-loss" },
              { icon: TrendingUp, label: "Avg Return",   value: stats.avgReturn !== 0 ? `$${stats.avgReturn}` : "--",   color: stats.avgReturn >= 0 ? "text-profit" : "text-loss" },
              { icon: Trophy,     label: "Best Trade",   value: stats.bestTrade > 0 ? `+$${stats.bestTrade}` : "--",    color: "text-profit" },
              { icon: Activity,   label: "Worst Trade",  value: stats.worstTrade < 0 ? `-$${Math.abs(stats.worstTrade)}` : "--", color: "text-loss" },
              { icon: BarChart3,  label: "Sharpe Ratio", value: stats.sharpeRatio !== 0 ? stats.sharpeRatio.toFixed(2) : "--" },
              { icon: Calendar,   label: "Active Since", value: stats.activeSince },
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
    </>
  );
}
