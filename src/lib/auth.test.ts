import { beforeEach, describe, expect, it, vi } from "vitest";

const signOutSpy = vi.fn().mockResolvedValue({ error: null });

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: signOutSpy } },
}));

const { signOut, intentionalSignOutRecently } = await import("./auth");

describe("signOut", () => {
  beforeEach(() => signOutSpy.mockClear());

  it("scopes to this browser by default", async () => {
    // The whole point of the wrapper: supabase-js defaults to "global", which
    // ends the user's session on every device they own.
    await signOut();
    expect(signOutSpy).toHaveBeenCalledWith({ scope: "local" });
  });

  it("still allows an explicit sign-out everywhere", async () => {
    await signOut("global");
    expect(signOutSpy).toHaveBeenCalledWith({ scope: "global" });
  });

  it("marks the sign-out as intentional before supabase is called", async () => {
    // auth-js emits SIGNED_OUT synchronously from inside the call, so the flag
    // has to be set by the time the listener runs — not after the await.
    signOutSpy.mockImplementationOnce(async () => {
      expect(intentionalSignOutRecently()).toBe(true);
      return { error: null };
    });
    await signOut();
    expect(signOutSpy).toHaveBeenCalledOnce();
  });

  it("stops reporting a sign-out as intentional once the window passes", async () => {
    vi.useFakeTimers();
    try {
      await signOut();
      expect(intentionalSignOutRecently(5_000)).toBe(true);
      vi.advanceTimersByTime(5_001);
      expect(intentionalSignOutRecently(5_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
