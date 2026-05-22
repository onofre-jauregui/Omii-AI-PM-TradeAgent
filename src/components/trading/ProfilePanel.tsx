import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wallet, Loader2, Zap, Camera, AlertCircle, CheckCircle, Circle } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AvatarCropModal } from "./AvatarCropModal";

interface Props {
  mode?: "paper" | "live";
  userEmail?: string;
}

const providerLabel: Record<string, string> = {
  openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI", google: "Google AI",
};

export function ProfilePanel({ mode = "paper", userEmail }: Props) {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState({
    displayName: "Anon Trader", email: "", kalshiUsername: "", avatarUrl: "",
  });
  const [subscription, setSubscription] = useState<{ tier: string; status: string } | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [kalshiConnected, setKalshiConnected] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const [{ data: prof }, { data: sub }, { data: keys }] = await Promise.all([
        supabase.from("profiles").select("display_name, avatar_url").eq("id", user.id).maybeSingle(),
        supabase.from("subscriptions").select("tier, status").eq("user_id", user.id).maybeSingle(),
        supabase.from("api_keys").select("provider"),
      ]);
      setProfile(prev => ({
        ...prev,
        email: user.email ?? "",
        displayName: prof?.display_name ?? prev.displayName,
        avatarUrl: prof?.avatar_url ?? "",
      }));
      setSubscription(sub ?? { tier: "free", status: "inactive" });
      if (keys) {
        const providers = new Set(keys.map(r => r.provider));
        setKalshiConnected(providers.has("kalshi_live"));
        setActiveProvider(["openrouter", "anthropic", "openai", "google"].find(p => providers.has(p)) ?? null);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setCropSrc(URL.createObjectURL(file));
    e.target.value = "";
  };

  const handleCropConfirm = async (blob: Blob) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUploadingAvatar(true);
    setUploadError(null);
    const path = `${user.id}/avatar.jpg`;
    const { error: uploadErr } = await supabase.storage
      .from("avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
    if (uploadErr) {
      setUploadError(uploadErr.message);
    } else {
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

  const tierLabel = (tier: string) =>
    ({ free: "Free Trial", starter: "Starter", pro: "Pro", prop: "Prop" }[tier] ?? tier);

  return (
    <>
      {cropSrc && (
        <AvatarCropModal imageSrc={cropSrc} onConfirm={handleCropConfirm} onCancel={handleCropCancel} />
      )}

      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        {/* ── Profile identity ──────────────────────────── */}
        <div className="p-6 space-y-5">
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
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelected} />
            {uploadError && (
              <div className="flex items-center gap-1.5 text-[11px] text-loss">
                <AlertCircle className="h-3 w-3 shrink-0" /><span>Upload failed: {uploadError}</span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Click to change photo</p>
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
              <Input value={profile.kalshiUsername} onChange={(e) => setProfile(prev => ({ ...prev, kalshiUsername: e.target.value }))} placeholder="your-kalshi-username" className="rounded-xl border-0 bg-secondary text-sm" />
            </div>
            <Button className="w-full rounded-full gap-2 text-sm" onClick={handleSaveProfile} disabled={saving || loading}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
              {saving ? "Saving…" : "Save Profile"}
            </Button>
          </div>

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

        {/* ── Status rows ───────────────────────────────── */}
        <div className="border-t border-border divide-y divide-border">
          <div className="flex items-center justify-between px-6 py-3">
            <span className="text-sm text-muted-foreground">AI Provider</span>
            <div className="flex items-center gap-1.5">
              {activeProvider
                ? <CheckCircle className="h-3 w-3 text-profit" />
                : <Circle className="h-3 w-3 text-muted-foreground" />}
              <span className="text-sm">{activeProvider ? providerLabel[activeProvider] : "Not configured"}</span>
            </div>
          </div>
          <div className="flex items-center justify-between px-6 py-3">
            <span className="text-sm text-muted-foreground">Kalshi</span>
            <div className="flex items-center gap-1.5">
              {kalshiConnected
                ? <><CheckCircle className="h-3 w-3 text-profit" /><span className="text-sm">Connected</span></>
                : <><Circle className="h-3 w-3 text-muted-foreground" /><span className="text-sm text-muted-foreground">Not connected</span></>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
