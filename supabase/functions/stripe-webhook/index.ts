import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { verifyStripeSignature, priceIdToTier, type Tier, type SubscriptionStatus } from "../_shared/billing.ts";

/**
 * stripe-webhook: Receives Stripe webhook events and updates the
 * subscriptions table. This is the source of truth for tier and status.
 *
 * Idempotency: every event is recorded in stripe_events keyed by Stripe's
 * event id. Re-deliveries are no-ops.
 *
 * Required env vars:
 *  - STRIPE_WEBHOOK_SECRET (whsec_...)
 *  - STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, STRIPE_PRICE_PROP
 *  - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Events handled:
 *  - checkout.session.completed     → mark subscription active
 *  - customer.subscription.created  → seed subscription row
 *  - customer.subscription.updated  → update tier/status/period
 *  - customer.subscription.deleted  → mark canceled
 *  - invoice.payment_failed         → mark past_due
 *
 * Other event types are recorded but no state change applied.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!webhookSecret) {
    return new Response(JSON.stringify({ error: "STRIPE_WEBHOOK_SECRET not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Read raw body for signature verification (must NOT use req.json() first)
  const rawBody = await req.text();
  const sigHeader = req.headers.get("Stripe-Signature") || req.headers.get("stripe-signature") || "";

  const verification = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!verification.valid) {
    console.warn("stripe-webhook: signature verification failed:", verification.reason);
    return new Response(
      JSON.stringify({ error: `Signature verification failed: ${verification.reason}` }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Idempotency: try to insert the event. Conflict on event id = already processed.
  const { error: idemErr } = await supabase.from("stripe_events").insert({
    id: event.id,
    type: event.type,
    payload: event,
    status: "received",
  });

  if (idemErr) {
    // Likely a duplicate delivery. Return 200 so Stripe stops retrying.
    if (idemErr.code === "23505") {
      return new Response(
        JSON.stringify({ received: true, duplicate: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.error("stripe-webhook: idempotency insert failed:", idemErr);
  }

  const env: Record<string, string | undefined> = {
    STRIPE_PRICE_STARTER: Deno.env.get("STRIPE_PRICE_STARTER"),
    STRIPE_PRICE_PRO: Deno.env.get("STRIPE_PRICE_PRO"),
    STRIPE_PRICE_PROP: Deno.env.get("STRIPE_PRICE_PROP"),
  };

  try {
    const obj = event.data?.object || {};

    switch (event.type) {
      case "checkout.session.completed": {
        // Stripe puts the user_id in client_reference_id when we initiate checkout
        const userId = obj.client_reference_id || obj.metadata?.user_id;
        const customerId = obj.customer;
        const subscriptionId = obj.subscription;

        if (!userId) {
          console.warn("stripe-webhook: checkout.session.completed without user_id");
          break;
        }

        await supabase.from("subscriptions").upsert(
          {
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            status: "active",
            tier: "starter",  // updated below by subscription.updated event
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscriptionId = obj.id;
        const customerId = obj.customer;
        const status: SubscriptionStatus = obj.status;
        const priceId = obj.items?.data?.[0]?.price?.id;
        const tier: Tier = priceIdToTier(priceId, env);

        // Resolve user_id from customer_id (must already exist from checkout)
        const { data: existing } = await supabase
          .from("subscriptions")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();

        const userId = existing?.user_id || obj.metadata?.user_id;
        if (!userId) {
          console.warn("stripe-webhook: subscription event without resolvable user_id, customer:", customerId);
          break;
        }

        await supabase.from("subscriptions").upsert(
          {
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            stripe_price_id: priceId,
            status,
            tier,
            current_period_start: obj.current_period_start
              ? new Date(obj.current_period_start * 1000).toISOString()
              : null,
            current_period_end: obj.current_period_end
              ? new Date(obj.current_period_end * 1000).toISOString()
              : null,
            cancel_at_period_end: obj.cancel_at_period_end || false,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "stripe_subscription_id" }
        );
        break;
      }

      case "customer.subscription.deleted": {
        const subscriptionId = obj.id;
        await supabase
          .from("subscriptions")
          .update({
            status: "canceled" as SubscriptionStatus,
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subscriptionId);
        break;
      }

      case "invoice.payment_failed": {
        const subscriptionId = obj.subscription;
        if (subscriptionId) {
          await supabase
            .from("subscriptions")
            .update({
              status: "past_due" as SubscriptionStatus,
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", subscriptionId);
        }
        break;
      }

      default:
        // Recorded but no state change
        break;
    }

    await supabase
      .from("stripe_events")
      .update({ status: "processed" })
      .eq("id", event.id);

    return new Response(
      JSON.stringify({ received: true, type: event.type }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error("stripe-webhook handler error:", errMsg);

    await supabase
      .from("stripe_events")
      .update({ status: "error", error_message: errMsg })
      .eq("id", event.id);

    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
