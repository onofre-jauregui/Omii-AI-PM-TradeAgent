import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateAuthHeaders, getKalshiCredentials, KALSHI_BASE_URL, fetchWithRetry } from "../_shared/kalshi-auth.ts";
import { makeCorsHeaders, preflight } from "../_shared/cors.ts";
import { resolveTenant } from "../_shared/tenant.ts";

// Module-level, so it resets on cold start but doesn't spam compliance_log on
// every warm-instance request — one warning per instance lifetime is enough
// to catch a silent regression back to the anonymous (rate-limited) tier.
let loggedMissingServiceKey = false;

const CREDENTIAL_FETCH_TIMEOUT_MS = 8_000; // same bound as market-data-fetcher/health-check/reconcile-orders/settle-signals/kalshi-ping/futures-signal

// The service-tenant credential is one static row shared by every request on
// this path (public market/events/series browsing — the highest-traffic
// endpoint, hit on every page load's category tabs + pre-warm + trending
// fan-out, up to 6 concurrent per the frontend's own cap). Re-fetching and
// re-decrypting the same row on every single request serializes on the DB
// under that concurrency and was the direct cause of the
// `kalshi_proxy_service_credential_fetch_failed` timeouts observed
// 2026-07-29 (5 occurrences in ~3h, all bursts of concurrent requests).
// Caching it per warm instance with a TTL removes the DB round trip from the
// hot path entirely while still picking up a key rotation within 5 minutes.
const SERVICE_CREDENTIAL_CACHE_TTL_MS = 5 * 60_000;
let cachedServiceCredential: { keyId: string; privateKey: string; expiresAt: number } | null = null;

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req, "extended");

  const corsHeaders = makeCorsHeaders(req.headers.get("origin"), "extended");

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint") || "markets";

    // Public endpoints (market data) don't need auth
    const isPublicEndpoint =
      endpoint.startsWith("markets") || endpoint.startsWith("events") || endpoint.startsWith("series");

    const apiPath = `/trade-api/v2/${endpoint}`;
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    if (!isPublicEndpoint) {
      const { userId } = await resolveTenant(req, adminClient);
      // Bare `await` here would hang this request indefinitely on a stalled
      // query — same class of unguarded-credential-fetch bug fixed in
      // market-data-fetcher/health-check/reconcile-orders/settle-signals/
      // kalshi-ping/futures-signal. Unlike those cron-driven paths, this one
      // is hit synchronously by every authenticated frontend call through the
      // proxy (portfolio, orders, trades) — a hang here stalls the user's
      // request until the platform's own execution timeout kills it.
      let kalshiKeyId: string | null, kalshiPrivateKey: string | null;
      try {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`credential fetch exceeded ${CREDENTIAL_FETCH_TIMEOUT_MS}ms`)),
            CREDENTIAL_FETCH_TIMEOUT_MS
          );
        });
        try {
          const creds = await Promise.race([getKalshiCredentials(adminClient, userId), timeout]);
          kalshiKeyId = creds.keyId;
          kalshiPrivateKey = creds.privateKey;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (credError) {
        const msg = credError instanceof Error ? credError.message : String(credError);
        console.error(`kalshi-proxy: credential fetch failed or timed out for user ${userId}: ${msg}`);
        await adminClient.from("compliance_log").insert({
          event_type: "kalshi_proxy_credential_fetch_failed",
          severity: "error",
          message: `kalshi-proxy credential fetch failed or timed out: ${msg}`,
        });
        return new Response(
          JSON.stringify({ error: "Could not verify Kalshi credentials right now — please try again." }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!kalshiKeyId || !kalshiPrivateKey) {
        return new Response(
          JSON.stringify({ error: "Kalshi live API credentials not configured. Add them in Settings." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const timestamp = Date.now();
      headers = await generateAuthHeaders(kalshiKeyId, kalshiPrivateKey, req.method, apiPath, timestamp);
    } else {
      // Public data doesn't require a per-user key, but signing with the
      // service-tenant credential (seeded 2026-07-14 for market-data-fetcher)
      // moves these calls off Kalshi's lowest anonymous rate tier onto the
      // authenticated tier. No key configured → fall back to unauthenticated,
      // same as before. Read-only endpoints only, so this never risks a trade.
      //
      // Bare `await` here would hang this request indefinitely on a stalled
      // query — same class of unguarded-credential-fetch bug fixed at the
      // authenticated branch above and across market-data-fetcher/health-check/
      // reconcile-orders/settle-signals/kalshi-ping/futures-signal. A prior
      // health-check run (57th) left this call site unguarded on the reasoning
      // that "it has its own existing unauthenticated-fallback path so a stall
      // degrades rather than hangs" — that's incorrect: the fallback below only
      // triggers when the query *resolves* with a falsy value, not when it never
      // resolves at all. This is the highest-traffic remaining unguarded site —
      // hit on every public market/events/series browse, logged in or not.
      let serviceKeyId: string | null, servicePrivateKey: string | null;
      if (cachedServiceCredential && cachedServiceCredential.expiresAt > Date.now()) {
        serviceKeyId = cachedServiceCredential.keyId;
        servicePrivateKey = cachedServiceCredential.privateKey;
      } else {
        try {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`credential fetch exceeded ${CREDENTIAL_FETCH_TIMEOUT_MS}ms`)),
              CREDENTIAL_FETCH_TIMEOUT_MS
            );
          });
          try {
            const creds = await Promise.race([getKalshiCredentials(adminClient, null), timeout]);
            serviceKeyId = creds.keyId;
            servicePrivateKey = creds.privateKey;
          } finally {
            clearTimeout(timeoutId);
          }
          if (serviceKeyId && servicePrivateKey) {
            cachedServiceCredential = {
              keyId: serviceKeyId,
              privateKey: servicePrivateKey,
              expiresAt: Date.now() + SERVICE_CREDENTIAL_CACHE_TTL_MS,
            };
          }
        } catch (credError) {
          const msg = credError instanceof Error ? credError.message : String(credError);
          console.error(`kalshi-proxy: service-tenant credential fetch failed or timed out: ${msg}`);
          await adminClient.from("compliance_log").insert({
            event_type: "kalshi_proxy_service_credential_fetch_failed",
            severity: "error",
            message: `kalshi-proxy public-endpoint service-tenant credential fetch failed or timed out: ${msg} — falling back to the anonymous rate tier for this request.`,
          });
          serviceKeyId = null;
          servicePrivateKey = null;
        }
      }
      if (serviceKeyId && servicePrivateKey) {
        const timestamp = Date.now();
        headers = await generateAuthHeaders(serviceKeyId, servicePrivateKey, req.method, apiPath, timestamp);
      } else if (!loggedMissingServiceKey) {
        loggedMissingServiceKey = true;
        await adminClient.from("compliance_log").insert({
          event_type: "kalshi_proxy_unauthenticated_fallback",
          severity: "warning",
          message: "kalshi-proxy public endpoint has no service-tenant Kalshi key — falling back to the anonymous rate tier (429-prone).",
        });
      }
    }

    const kalshiUrl = new URL(`${KALSHI_BASE_URL}/${endpoint}`);
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== "endpoint") kalshiUrl.searchParams.set(key, value);
    }

    const fetchOptions: RequestInit = { method: req.method, headers };
    if (req.method === "POST" || req.method === "PUT") {
      const body = await req.text();
      if (body) fetchOptions.body = body;
    }

    const response = await fetchWithRetry(kalshiUrl.toString(), fetchOptions);
    const rawBody = await response.text();
    let data: unknown;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch (parseError) {
      // Capture the actual malformed body — without this, a bad Kalshi response
      // is indistinguishable from any other exception and undiagnosable on repeat.
      const parseErrMsg = parseError instanceof Error ? parseError.message : "JSON parse failed";
      await adminClient.from("compliance_log").insert({
        event_type: "api_error",
        severity: "error",
        message: `Kalshi API returned non-JSON response on ${req.method} ${endpoint} (status ${response.status}): ${parseErrMsg}`,
        metadata: { status: response.status, endpoint, full_path: apiPath, raw_body: rawBody.slice(0, 500) },
      });
      return new Response(
        JSON.stringify({ error: "Kalshi API returned an unexpected response format", status: response.status }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!response.ok) {
      await adminClient.from("compliance_log").insert({
        event_type: "api_error",
        severity: response.status >= 500 ? "error" : "warning",
        message: `Kalshi API error on ${req.method} ${endpoint}: ${response.status}`,
        metadata: { status: response.status, response: data, endpoint, full_path: apiPath },
      });
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Internal proxy error";
    console.error("kalshi-proxy error:", error);
    // TCP-level failures (connection reset, refused, timeout) are infrastructure blips —
    // not Kalshi API errors. Classify separately so health-check doesn't alert on them.
    const isNetworkBlip = /connection reset|connection refused|timed out|network error/i.test(errMsg);
    try {
      await adminClient.from("compliance_log").insert({
        event_type: isNetworkBlip ? "kalshi_network_blip" : "api_error",
        severity: isNetworkBlip ? "info" : "error",
        message: `kalshi-proxy ${isNetworkBlip ? "network blip (after retries)" : "exception"}: ${errMsg.slice(0, 200)}`,
        metadata: { provider: "kalshi", error: errMsg },
      });
    } catch { /* never throw from catch */ }
    return new Response(JSON.stringify({ error: errMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
