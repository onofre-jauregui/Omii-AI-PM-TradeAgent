import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Onboarding is where a user hands over their Kalshi API credentials. A rejected
// key used to produce no visible feedback at all: saveKalshiKey() set a
// `saveStatus` that was never rendered, and testConnection() returned early
// before touching `pingStatus`, so the already-built failure banner never fired.
// These tests walk the real wizard to the key step rather than calling the
// handlers directly — the bug lived in the wiring between them, not in either one.

const getSession = vi.fn();
const getUser = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
      getUser: () => getUser(),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ single: () => Promise.resolve({ data: null }) }),
      }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  },
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import OnboardingPage from "./OnboardingPage";

/** Click through Welcome → Name → AI key, landing on the Kalshi connect step. */
async function goToConnectStep() {
  fireEvent.click(await screen.findByRole("button", { name: /get started/i }));
  fireEvent.click(await screen.findByRole("button", { name: /skip for now/i }));
  fireEvent.click(await screen.findByRole("button", { name: /skip — add later in settings/i }));
  await screen.findByRole("button", { name: /save & test connection/i });
}

function enterKey(keyId: string, privateKey: string) {
  fireEvent.change(screen.getByPlaceholderText(/xxxxxxxx-xxxx/i), { target: { value: keyId } });
  fireEvent.change(screen.getByPlaceholderText(/paste pem private key/i), { target: { value: privateKey } });
}

function clickSaveAndTest() {
  fireEvent.click(screen.getByRole("button", { name: /save & test connection/i }));
}

describe("OnboardingPage — Kalshi key step", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", user_metadata: {} }, access_token: "token" } },
    });
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("surfaces the server's error when the key is rejected, instead of failing silently", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: "Invalid RSA private key format" }),
    });

    render(<OnboardingPage />);
    await goToConnectStep();
    enterKey("bad-key-id", "not-a-real-pem");
    clickSaveAndTest();

    expect(await screen.findByText("Invalid RSA private key format")).toBeInTheDocument();
  });

  it("still shows an error when the save request throws outright", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network down"));

    render(<OnboardingPage />);
    await goToConnectStep();
    enterKey("abc", "def");
    clickSaveAndTest();

    expect(await screen.findByText("Network down")).toBeInTheDocument();
  });

  it("re-saves a corrected key after a failure rather than re-testing the old one", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    // First save succeeds but the ping rejects the key, so the user edits it.
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: false, error: "Kalshi rejected the key" }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, balance_usd: 42 }) });

    render(<OnboardingPage />);
    await goToConnectStep();
    enterKey("typo-key", "typo-pem");
    clickSaveAndTest();
    expect(await screen.findByText("Kalshi rejected the key")).toBeInTheDocument();

    fetchMock.mockClear();
    enterKey("fixed-key", "fixed-pem");
    clickSaveAndTest();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const savedBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("save-kalshi-key"))
      .map(([, init]) => String((init as RequestInit).body));

    // The stale-saveStatus bug skipped this second save entirely, silently
    // re-testing the original bad key and trapping the user on the error.
    expect(savedBodies).toHaveLength(1);
    expect(savedBodies[0]).toContain("fixed-key");
  });
});
