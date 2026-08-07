/**
 * Regression guard for the permanent-spinner outage on /observability
 * (Chrome console: 400 on /auth/v1/token?grant_type=refresh_token, page never paints).
 *
 * supabase-js holds its auth lock for the whole duration of every onAuthStateChange
 * listener. AdminRoute's listener used to call back into a function that awaited
 * supabase.auth.getSession(), which cannot acquire a lock the caller is still holding —
 * so the await never settled and the gate stayed on "loading" forever. A stale refresh
 * token is what reliably fires the extra auth event that triggers it.
 *
 * The mock below reproduces that lock: getSession() never resolves while a listener
 * callback is on the stack. If AdminRoute re-enters it from the listener, these tests
 * time out instead of reaching a terminal state.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AuthListener = (event: string, session: unknown | null) => void;

const listeners: AuthListener[] = [];
/** True while a listener callback is executing — stands in for the held auth lock. */
let lockHeld = false;
let getSessionResult: { data: { session: unknown | null }; error: unknown | null };
let signOutCalls = 0;
let profileRow: { is_admin: boolean } | null;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () =>
        new Promise((resolve) => {
          // Deadlock exactly as supabase-js would: a caller inside a listener never
          // gets the lock back, so this promise is left permanently pending.
          if (lockHeld) return;
          resolve(getSessionResult);
        }),
      signOut: async () => {
        signOutCalls += 1;
        return { error: null };
      },
      onAuthStateChange: (cb: AuthListener) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithPassword: async () => ({ error: null }),
      signInWithOAuth: async () => ({ error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (lockHeld) await new Promise(() => {});
            return { data: profileRow, error: null };
          },
        }),
      }),
    }),
  },
}));

/** Fire an auth event with the lock held, the way supabase-js actually does it. */
function emitAuthEvent(event: string, session: unknown | null) {
  lockHeld = true;
  try {
    listeners.forEach((cb) => cb(event, session));
  } finally {
    lockHeld = false;
  }
}

const ADMIN_SESSION = { user: { id: "admin-1" } };

let AdminRoute: typeof import("./App").AdminRoute;

beforeEach(async () => {
  listeners.length = 0;
  lockHeld = false;
  signOutCalls = 0;
  profileRow = { is_admin: true };
  getSessionResult = { data: { session: null }, error: null };
  ({ AdminRoute } = await import("./App"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AdminRoute auth gate", () => {
  it("resolves to the guarded page when an auth event arrives while the lock is held", async () => {
    render(<AdminRoute element={<div>observability</div>} />);
    await screen.findByText("Admin access"); // initial no-session pass → login form

    emitAuthEvent("SIGNED_IN", ADMIN_SESSION);

    expect(await screen.findByText("observability")).toBeInTheDocument();
  });

  it("denies a signed-in non-admin instead of hanging", async () => {
    profileRow = { is_admin: false };
    render(<AdminRoute element={<div>observability</div>} />);
    await screen.findByText("Admin access");

    emitAuthEvent("SIGNED_IN", ADMIN_SESSION);

    expect(await screen.findByText(/Access denied/)).toBeInTheDocument();
  });

  it("falls back to the login form when the listener reports a signed-out session", async () => {
    getSessionResult = { data: { session: ADMIN_SESSION }, error: null };
    render(<AdminRoute element={<div>observability</div>} />);
    await screen.findByText("observability");

    emitAuthEvent("SIGNED_OUT", null);

    expect(await screen.findByText("Admin access")).toBeInTheDocument();
  });

  it("clears a rejected refresh token so the next load is not a doomed retry", async () => {
    // What the browser actually reported: refresh_token exchange returns 400, so
    // getSession() surfaces an error alongside a null session.
    getSessionResult = { data: { session: null }, error: { status: 400, message: "Invalid Refresh Token" } };

    render(<AdminRoute element={<div>observability</div>} />);

    expect(await screen.findByText("Admin access")).toBeInTheDocument();
    await waitFor(() => expect(signOutCalls).toBe(1));
  });
});
