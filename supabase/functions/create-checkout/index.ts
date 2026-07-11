import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

/**
 * create-checkout: Creates a Stripe Checkout session for plan upgrades.
 * Called from the billing page when a user clicks "Upgrade".
 *
 * Request body: { tier: "starter" | "pro" | "prop" }
 * Response: { url: string } — redirect the user to this Stripe-hosted URL.
 *
 * Required Supabase secrets:
 *   STRIPE_SECRET_KEY, STRIPE_STARTER_PRICE_ID, STRIPE_PRO_PRICE_ID, STRIPE_PROP_PRICE_ID
 *   FRONTEND_URL (your Vercel domain, used for success/cancel redirect)
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const frontendUrl = Deno.env.get("FRONTEND_URL") || "https://kalshitradeagent.com";

  if (!supabaseUrl || !supabaseKey) return json({ error: "Missing server credentials" }, 500);
  if (!stripeKey) return json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY in Supabase secrets." }, 500);

  // Auth gate
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? supabaseKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await anonClient.auth.getUser();
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const tier = body?.tier as string;

  const priceIds: Record<string, string | undefined> = {
    starter: Deno.env.get("STRIPE_PRICE_STARTER"),
    pro:     Deno.env.get("STRIPE_PRICE_PRO"),
    prop:    Deno.env.get("STRIPE_PRICE_PROP"),
  };

  const priceId = priceIds[tier];
  if (!priceId) {
    return json({
      error: `No Stripe price ID configured for tier "${tier}". Set STRIPE_PRICE_${tier.toUpperCase()} in Supabase secrets.`,
    }, 400);
  }

  // Create or retrieve Stripe customer for this user
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = sub?.stripe_customer_id;

  if (!customerId) {
    // Create a new Stripe customer
    const customerResp = await fetch("https://api.stripe.com/v1/customers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: user.email ?? "",
        metadata: JSON.stringify({ supabase_user_id: user.id }),
      }).toString(),
    });
    const customer = await customerResp.json();
    if (!customerResp.ok) {
      return json({ error: `Stripe customer error: ${customer?.error?.message}` }, 500);
    }
    customerId = customer.id;

    // Upsert the subscriptions row with the new customer ID
    await supabase.from("subscriptions").upsert(
      { user_id: user.id, stripe_customer_id: customerId, tier: "free", status: "inactive", updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  }

  // Create Stripe Checkout session
  const sessionResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      customer: customerId,
      client_reference_id: user.id,
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${frontendUrl}/billing?upgraded=1`,
      cancel_url: `${frontendUrl}/billing`,
      "metadata[user_id]": user.id,
      "metadata[tier]": tier,
    }).toString(),
  });

  const session = await sessionResp.json();
  if (!sessionResp.ok) {
    return json({ error: `Stripe session error: ${session?.error?.message}` }, 500);
  }

  return json({ url: session.url });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
