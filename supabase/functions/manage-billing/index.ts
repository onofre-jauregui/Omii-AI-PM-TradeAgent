import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

/**
 * manage-billing: Creates a Stripe Billing Portal session.
 * Redirects the user to Stripe's hosted portal where they can update their
 * payment method, view invoices, and cancel their subscription.
 *
 * Required Supabase secrets: STRIPE_SECRET_KEY, FRONTEND_URL
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const frontendUrl = Deno.env.get("FRONTEND_URL") || "https://omii-ai-pm-trade-agent.vercel.app";

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

  // Look up this user's Stripe customer ID
  const adminClient = createClient(supabaseUrl, supabaseKey);
  const { data: sub } = await adminClient
    .from("subscriptions")
    .select("stripe_customer_id, status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!sub?.stripe_customer_id) {
    return json({ error: "No active subscription found. Upgrade to a paid plan first." }, 404);
  }

  // Create a Stripe Billing Portal session
  const portalResp = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      customer: sub.stripe_customer_id,
      return_url: `${frontendUrl}/billing`,
    }),
  });

  const portal = await portalResp.json();
  if (!portalResp.ok) {
    return json({ error: portal.error?.message ?? "Failed to create billing portal session." }, 500);
  }

  return json({ url: portal.url });
});
