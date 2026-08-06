import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle, Loader2, ExternalLink, Settings } from "lucide-react";
import { PAID_TIERS, FREE_TIER, tierFeatures, tierPriceLabel } from "@/lib/pricing";

const CHECKOUT_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/create-checkout`;
const MANAGE_BILLING_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/manage-billing`;

// Plans, prices and limits come from src/lib/pricing.ts — the same table the
// landing page renders and the same numbers the server enforces.
const PLANS = PAID_TIERS;

export default function BillingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentTier, setCurrentTier] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [managingBilling, setManagingBilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upgraded = searchParams.get("upgraded") === "1";

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { navigate("/"); return; }

      const { data: sub } = await supabase
        .from("subscriptions")
        .select("tier, status")
        .eq("user_id", user.id)
        .maybeSingle();

      setCurrentTier(sub?.tier ?? "free");
      setStatus(sub?.status ?? "inactive");
      setLoading(false);
    })();
  }, [navigate]);

  async function handleManageBilling() {
    setManagingBilling(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(MANAGE_BILLING_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const data = await resp.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error ?? "Could not open billing portal.");
        setManagingBilling(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setManagingBilling(false);
    }
  }

  async function handleUpgrade(tier: string) {
    setUpgrading(tier);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tier }),
      });
      const json = await resp.json();
      if (json.url) {
        window.location.href = json.url;
      } else {
        setError(json.error ?? "Could not create checkout session.");
        setUpgrading(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setUpgrading(null);
    }
  }

  const isActive = status === "active" || status === "trialing";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-10">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate("/")} className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Billing</h1>
              {!loading && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Current plan: <span className="capitalize font-medium text-foreground">{currentTier ?? "Free"}</span>
                  {isActive && <span className="ml-1.5 text-emerald-500">· Active</span>}
                </p>
              )}
            </div>
          </div>
          {isActive && currentTier !== "free" && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full gap-2 text-xs"
              onClick={handleManageBilling}
              disabled={managingBilling}
            >
              {managingBilling ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening…</>
              ) : (
                <><Settings className="h-3.5 w-3.5" /> Manage Subscription</>
              )}
            </Button>
          )}
        </div>

        {upgraded && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4 mb-8 flex items-center gap-3">
            <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              Subscription activated. Your plan limits are now in effect.
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-5 py-4 mb-8 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Free tier note */}
        <div className="rounded-xl border border-border bg-secondary/30 px-5 py-4 mb-8">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{FREE_TIER.name} — {FREE_TIER.description}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{tierFeatures(FREE_TIER).join(" · ")}</p>
            </div>
            {(currentTier === "free" || !currentTier) && (
              <span className="text-xs bg-secondary text-muted-foreground px-2.5 py-1 rounded-full">Current</span>
            )}
          </div>
        </div>

        {/* Paid plans */}
        <div className="grid md:grid-cols-3 gap-4">
          {PLANS.map((plan) => {
            const isCurrent = currentTier === plan.id && isActive;
            const isUpgrading = upgrading === plan.id;

            return (
              <div
                key={plan.id}
                className={`rounded-2xl border overflow-hidden flex flex-col ${
                  plan.highlight
                    ? "border-foreground/30 bg-foreground/5"
                    : "border-border bg-card"
                }`}
              >
                {plan.highlight && (
                  <div className="bg-foreground text-background text-center text-[10px] font-semibold tracking-widest uppercase py-1.5">
                    Most Popular
                  </div>
                )}
                <div className="p-6 flex-1 flex flex-col">
                  <div className="mb-5">
                    <h3 className="font-semibold text-base">{plan.name}</h3>
                    <p className="text-muted-foreground text-xs mt-0.5">{plan.description}</p>
                    <div className="mt-4 flex items-baseline gap-1">
                      <span className="text-3xl font-bold">{tierPriceLabel(plan)}</span>
                      <span className="text-muted-foreground text-sm">/mo</span>
                    </div>
                  </div>

                  <ul className="space-y-2 flex-1 mb-6">
                    {tierFeatures(plan).map((f) => (
                      <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <CheckCircle className="h-3.5 w-3.5 text-emerald-500 mt-0.5 shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>

                  {isCurrent ? (
                    <div className="w-full text-center text-sm text-muted-foreground py-2 border border-border rounded-full">
                      Current plan
                    </div>
                  ) : (
                    <Button
                      className="w-full rounded-full gap-2"
                      variant={plan.highlight ? "default" : "outline"}
                      onClick={() => handleUpgrade(plan.id)}
                      disabled={!!upgrading || loading}
                    >
                      {isUpgrading ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> Redirecting…</>
                      ) : (
                        <><ExternalLink className="h-3.5 w-3.5" /> Upgrade to {plan.name}</>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-8">
          Payments are processed by Stripe. Cancel anytime — no lock-in.
          Questions? Email <a href="mailto:omiiaiagency@gmail.com" className="underline">omiiaiagency@gmail.com</a>.
        </p>
      </div>
    </div>
  );
}
