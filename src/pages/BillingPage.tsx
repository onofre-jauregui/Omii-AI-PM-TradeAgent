import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle, Loader2, ExternalLink, Settings } from "lucide-react";
import { PAID_TIERS, FREE_TIER, BILLING_LIVE, tierFeatures, tierPriceLabel, tierLabel } from "@/lib/pricing";

const CHECKOUT_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/create-checkout`;
const MANAGE_BILLING_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/manage-billing`;
const WAITLIST_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/waitlist-signup`;

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
  const [email, setEmail] = useState<string | null>(null);
  const [joinedTier, setJoinedTier] = useState<string | null>(null);
  const upgraded = searchParams.get("upgraded") === "1";

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { navigate("/"); return; }

      setEmail(user.email ?? null);

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

  /**
   * Paid access is closed (see BILLING_LIVE). Record which plan the user wanted
   * rather than dropping the intent — `plan_interest` is what tells us which
   * tier to open first, and it is the only demand signal that exists while
   * checkout is shut.
   */
  async function handleJoinWaitlist(tier: string) {
    if (!email) {
      setError("Could not read your account email. Reload and try again.");
      return;
    }
    setUpgrading(tier);
    setError(null);
    try {
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
      const resp = await fetch(WAITLIST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ email, plan_interest: tier }),
      });
      const json = await resp.json();
      if (json.ok) {
        setJoinedTier(tier);
      } else {
        setError(json.error ?? "Could not join the waitlist. Please try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setUpgrading(null);
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
                  Current plan: <span className="font-medium text-foreground">{tierLabel(currentTier ?? "free")}</span>
                  {isActive && <span className="ml-1.5 text-emerald-500">· Active</span>}
                </p>
              )}
            </div>
          </div>
          {/* The Stripe customer portal has nothing to show while billing is closed —
              the paid rows that exist were set by hand and have no Stripe subscription
              behind them, so this button would open a portal session that errors. */}
          {BILLING_LIVE && isActive && currentTier !== "free" && (
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

        {/* Say plainly that plans can't be bought yet. Showing four priced cards
            with no explanation reads as a broken checkout, not a deliberate one. */}
        {!BILLING_LIVE && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 mb-8">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              Paid plans are in closed access.
            </p>
            <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-1 leading-relaxed">
              We're validating paper-trading performance before opening live
              accounts. Pick the plan you want below and we'll email you the
              moment your spot is ready — nothing is charged today.
            </p>
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
                  ) : joinedTier === plan.id ? (
                    <div className="w-full text-center text-sm py-2 border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center gap-2">
                      <CheckCircle className="h-3.5 w-3.5" /> You're on the list
                    </div>
                  ) : BILLING_LIVE ? (
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
                  ) : (
                    <Button
                      className="w-full rounded-full gap-2"
                      variant={plan.highlight ? "default" : "outline"}
                      onClick={() => handleJoinWaitlist(plan.id)}
                      disabled={!!upgrading || loading}
                    >
                      {isUpgrading ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> Joining…</>
                      ) : (
                        <>Join the waitlist</>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-8">
          {BILLING_LIVE
            ? "Payments are processed by Stripe. Cancel anytime — no lock-in."
            : "No payment details are collected while access is closed. Prices are what you'll pay when it opens."}
          {" "}Questions? Email <a href="mailto:omiiaiagency@gmail.com" className="underline">omiiaiagency@gmail.com</a>.
        </p>
      </div>
    </div>
  );
}
