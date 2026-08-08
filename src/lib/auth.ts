/**
 * The single sign-out path for the app.
 *
 * `supabase.auth.signOut()` defaults to `scope: 'global'`, which revokes every
 * session that user holds on every device — not just the one clicking the
 * button. The other devices find out the hard way: their next
 * `GET /auth/v1/user` returns 403 `session_not_found`, auth-js wipes
 * localStorage and emits SIGNED_OUT, and the app drops them on the marketing
 * page mid-session with no explanation.
 *
 * Verified against the live project on 2026-08-08: with two tokens issued for
 * one account, signing out one of them made the other's /auth/v1/user go
 * 200 → 403 `session_not_found`. With `?scope=local` the other stayed 200.
 *
 * Signing out of this browser must therefore be local. Signing out everywhere
 * is a deliberate, separate action — pass "global" explicitly.
 */
import { supabase } from "@/integrations/supabase/client";

/**
 * When the last intentional sign-out started. Read by the session-loss detector
 * so a sign-out the user asked for is never reported as a lost session.
 */
let lastIntentionalSignOutAt = 0;

/**
 * True if a sign-out was initiated from this tab within the window. auth-js
 * emits SIGNED_OUT synchronously from inside the sign-out call, so the stamp is
 * always set before any listener runs.
 */
export function intentionalSignOutRecently(withinMs = 5_000): boolean {
  return Date.now() - lastIntentionalSignOutAt < withinMs;
}

/**
 * Signs the user out. Defaults to this browser only.
 *
 * @param scope "local" ends this session; "global" ends the user's sessions on
 *   every device. Only pass "global" for an explicit "sign out everywhere".
 */
export async function signOut(scope: "local" | "global" = "local") {
  // Stamped before the await: the SIGNED_OUT event fires during the call, and
  // the detector has to already see that this one was asked for.
  lastIntentionalSignOutAt = Date.now();
  return supabase.auth.signOut({ scope });
}
