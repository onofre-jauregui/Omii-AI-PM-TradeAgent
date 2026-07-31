/**
 * Pure allowlist logic for kalshi-proxy — no external imports so it can be
 * tested under vitest without the Deno/ESM CDN dependencies index.ts requires.
 *
 * kalshi-proxy signs every passthrough request with the caller's own Kalshi
 * credentials and, before this allowlist existed, forwarded it to any
 * endpoint/method the client asked for — including POST/PUT portfolio/orders
 * (place a real live order) and bulk DELETE portfolio/orders (cancel every
 * resting order), neither of which any part of this app actually calls
 * (confirmed by a repo-wide grep of src/lib/kalshiApi.ts's callers: the only
 * write path the frontend uses is DELETE portfolio/orders/{id}, a single
 * resting-order cancel; real order placement goes through execute-trade,
 * which enforces risk.ts/limits.ts server-side before touching Kalshi).
 * Anyone hitting this endpoint directly with a valid Supabase session bearer
 * token — not just through the app's own UI — could place or bulk-cancel
 * real orders on their own account with zero app-level risk enforcement.
 */

export const READ_ENDPOINT_PREFIXES = [
  "markets", "series", "events",
  "portfolio/balance", "portfolio/positions", "portfolio/orders", "portfolio/fills",
];

export function isAllowedProxyRequest(method: string, endpoint: string): boolean {
  if (method === "GET") {
    return READ_ENDPOINT_PREFIXES.some(p => endpoint === p || endpoint.startsWith(`${p}/`) || endpoint.startsWith(`${p}?`));
  }
  if (method === "DELETE") {
    // Only single resting-order cancellation by id — no bulk cancel, no other DELETE endpoint.
    return /^portfolio\/orders\/[^/?]+$/.test(endpoint);
  }
  // POST/PUT (order placement, etc.) never goes through this general-purpose
  // proxy — execute-trade is the sole order-placement path.
  return false;
}
