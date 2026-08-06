// Makes Kalshi the source of truth for live trade P&L.
//
// Every other path in this system derives P&L from what the agent *requested*.
// This one reads /portfolio/settlements — actual revenue, actual cost basis,
// actual fee, actual settlement time — and writes it onto the trade rows, so
// `net_pnl` reflects money that really moved instead of an estimate.
//
// Runs on a cron and is also safe to invoke directly. Idempotent: a row whose
// values already match Kalshi is skipped, so a re-run touches nothing.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { generateAuthHeaders, getKalshiCredentials, KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";
import {
  allocateSettlement,
  type KalshiSettlement,
  type ReconcilableTrade,
} from "../_shared/ledger-reconcile.ts";

const SETTLEMENT_PAGE_LIMIT = 200;

Deno.serve(async (req) => {
  // preflight() always returns a Response — it does not inspect the method, so
  // it must be gated on OPTIONS or every request short-circuits with an empty body.
  if (req.method === "OPTIONS") return preflight(req);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Reconcile every tenant that has ever placed a live trade — a user whose
  // agent is idle today still has historical rows that may be mispriced.
  const { data: liveUsers, error: usersError } = await supabase
    .from("trades")
    .select("user_id")
    .eq("mode", "live")
    .not("user_id", "is", null);

  if (usersError) {
    return json({ error: `could not list live tenants: ${usersError.message}` }, 500);
  }
  const userIds = [...new Set((liveUsers ?? []).map((r: { user_id: string }) => r.user_id))];

  const results: Record<string, unknown>[] = [];

  for (const userId of userIds) {
    const creds = await getKalshiCredentials(supabase, userId);
    // keyId/privateKey are independently nullable on the credential record — a
    // half-populated row (key saved, secret decryption failed) would otherwise
    // reach the signer as null and fail with an opaque auth error per settlement.
    if (!creds?.keyId || !creds?.privateKey) {
      // Not an error: a user may have revoked their key. Recorded so a silently
      // un-reconciled tenant is visible rather than simply absent from the run.
      results.push({ user_id: userId, skipped: "no_kalshi_credentials" });
      continue;
    }
    const { keyId, privateKey } = creds;

    let settlements: KalshiSettlement[] = [];
    try {
      settlements = await fetchAllSettlements(keyId, privateKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from("compliance_log").insert({
        event_type: "ledger_reconcile_fetch_failed",
        severity: "error",
        message: `Could not read Kalshi settlements for ${userId}: ${message}`,
        user_id: userId,
      }).then(null, () => {});
      results.push({ user_id: userId, error: message });
      continue;
    }

    let updated = 0;
    let tied = 0;
    const drift: Record<string, number> = {};

    for (const settlement of settlements) {
      const { data: trades, error: tradesError } = await supabase
        .from("trades")
        .select("id, ticker, amount, pnl, net_pnl")
        .eq("mode", "live")
        .eq("user_id", userId)
        .eq("ticker", settlement.ticker)
        // Only rows that actually held contracts may receive settlement P&L.
        // Without this the allocator sweeps in every rejected and cancelled
        // order on the same ticker — the agent submits many attempts per event,
        // so a first run promoted 126 failed and 20 cancelled orders to
        // "settled" and diluted the real legs' P&L across all of them.
        // filled_at is the load-bearing test: an order that never filled has no
        // position for a settlement to describe, whatever its status says.
        .in("status", ["filled", "partial", "settled"])
        .not("filled_at", "is", null)
        // Exclude manually-closed positions: those exited before expiry, so the
        // settlement's revenue describes contracts this row no longer held and
        // applying it would overwrite a real realised close with a phantom.
        .is("exit_reason", null);

      if (tradesError) {
        await supabase.from("compliance_log").insert({
          event_type: "ledger_reconcile_query_failed",
          severity: "error",
          message: `Trade lookup failed for ${settlement.ticker}: ${tradesError.message}`,
          user_id: userId,
        }).then(null, () => {});
        continue;
      }
      if (!trades || trades.length === 0) continue;

      const rows = allocateSettlement(settlement, trades as ReconcilableTrade[]);

      for (const row of rows) {
        if (!row.changed) {
          tied++;
          continue;
        }
        const before = (trades as ReconcilableTrade[]).find((t) => t.id === row.id);
        drift[settlement.ticker] = (drift[settlement.ticker] ?? 0) +
          (row.net_pnl - Number(before?.net_pnl ?? before?.pnl ?? 0));

        const { error: updateError } = await supabase
          .from("trades")
          .update({
            pnl: row.pnl,
            net_pnl: row.net_pnl,
            exit_fee_cents: row.fee_cents,
            // Kalshi's settlement time, not when our cron noticed — this is what
            // put three 28 July trades on the 29th and skewed daily P&L.
            settled_at: row.settled_at,
            resolution: row.resolution,
            status: "settled",
            kalshi_reconciled_at: new Date().toISOString(),
          })
          .eq("id", row.id);

        if (updateError) {
          await supabase.from("compliance_log").insert({
            event_type: "ledger_reconcile_update_failed",
            severity: "error",
            message: `Could not write reconciled P&L for trade ${row.id}: ${updateError.message}`,
            metadata: { trade_id: row.id, ticker: settlement.ticker },
            user_id: userId,
          }).then(null, () => {});
          continue;
        }
        updated++;
      }
    }

    const netDrift = Object.values(drift).reduce((s, d) => s + d, 0);
    results.push({
      user_id: userId,
      settlements: settlements.length,
      updated,
      already_tied: tied,
      net_correction_usd: Math.round(netDrift * 100) / 100,
    });

    if (updated > 0) {
      await supabase.from("compliance_log").insert({
        event_type: "ledger_reconciled",
        severity: "info",
        message:
          `Reconciled ${updated} trade(s) against Kalshi (${settlements.length} settlements); net correction $${
            (Math.round(netDrift * 100) / 100).toFixed(2)
          }`,
        metadata: { updated, settlements: settlements.length, per_ticker_drift: drift },
        user_id: userId,
      }).then(null, () => {});
    }
  }

  return json({ ok: true, tenants: results });
});

/**
 * Pages through the settlements endpoint. Kalshi caps a page at 200 and returns
 * a cursor; stopping at the first page would silently un-reconcile the oldest
 * trades as history grows.
 */
async function fetchAllSettlements(
  keyId: string,
  privateKey: string,
): Promise<KalshiSettlement[]> {
  const all: KalshiSettlement[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 25; page++) {
    const query = `?limit=${SETTLEMENT_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const path = "/trade-api/v2/portfolio/settlements";
    const headers = await generateAuthHeaders(keyId, privateKey, "GET", path, Date.now());
    const response = await fetch(`${KALSHI_BASE_URL}/portfolio/settlements${query}`, { headers });

    if (!response.ok) {
      throw new Error(`Kalshi ${response.status} on /portfolio/settlements`);
    }
    const body = await response.json();
    all.push(...(body?.settlements ?? []));

    cursor = body?.cursor || undefined;
    if (!cursor || (body?.settlements ?? []).length === 0) break;
  }
  return all;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
