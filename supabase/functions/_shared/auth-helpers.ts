/**
 * Pure auth helper functions — no external imports so this file
 * can be tested under vitest without the Deno/ESM CDN dependencies
 * that other edge-function modules require.
 */

/**
 * Returns true if the provided bearer token is the service role key.
 * Used by resolveTenant() to distinguish internal system calls (which
 * supply user_id in the request body and are trusted) from unauthenticated
 * external callers (which must be rejected with 401).
 */
export function isServiceRoleBearer(
  bearer: string,
  serviceKey: string | undefined
): boolean {
  if (!bearer || !serviceKey) return false;
  return bearer === serviceKey;
}
