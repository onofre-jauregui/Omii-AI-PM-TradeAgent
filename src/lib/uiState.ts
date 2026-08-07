/**
 * Per-user dashboard UI state that survives reloads, PWA relaunches, and
 * returning to the tab days later — but is deliberately reset at every fresh
 * sign-in so a new session always opens on the paper Dashboard.
 *
 * Trading mode is NOT stored here: `profiles.trading_mode` is the account-level
 * setting the agent itself trades on, so the DB stays its single source of truth.
 * Mirroring it in localStorage could show "Paper" while the account is live.
 */

const STORAGE_KEY = "kta:ui-state:v1";

export type DashboardTab = "dashboard" | "agent" | "markets" | "settings";
export type AgentSubTab = "chat" | "strategies" | "risk" | "history" | "memory";

export interface PersistedUiState {
  /** Owner of the stored state — state belonging to another account is discarded. */
  userId: string | null;
  activeTab: DashboardTab;
  agentSubTab: AgentSubTab;
}

const DEFAULT_UI_STATE: PersistedUiState = {
  userId: null,
  activeTab: "dashboard",
  agentSubTab: "chat",
};

const VALID_TABS: DashboardTab[] = ["dashboard", "agent", "markets", "settings"];
const VALID_SUB_TABS: AgentSubTab[] = ["chat", "strategies", "risk", "history", "memory"];

/**
 * Reads the persisted state. Returns defaults when nothing is stored, when the
 * payload is corrupt, or when storage is unavailable (Safari private mode).
 */
export function readUiState(): PersistedUiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_STATE };
    const parsed = JSON.parse(raw) as Partial<PersistedUiState>;
    return {
      userId: typeof parsed.userId === "string" ? parsed.userId : null,
      activeTab: VALID_TABS.includes(parsed.activeTab as DashboardTab)
        ? (parsed.activeTab as DashboardTab)
        : DEFAULT_UI_STATE.activeTab,
      agentSubTab: VALID_SUB_TABS.includes(parsed.agentSubTab as AgentSubTab)
        ? (parsed.agentSubTab as AgentSubTab)
        : DEFAULT_UI_STATE.agentSubTab,
    };
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
}

export function writeUiState(state: PersistedUiState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked — persistence is a convenience, never a hard dependency.
  }
}

/** Called on sign-out and before any sign-in attempt, so the next session starts clean. */
export function clearUiState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

export { DEFAULT_UI_STATE };
