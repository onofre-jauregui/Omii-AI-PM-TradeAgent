import { beforeEach, describe, expect, it } from "vitest";
import { clearUiState, readUiState, writeUiState, DEFAULT_UI_STATE } from "./uiState";

describe("uiState", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to the paper dashboard when nothing is stored", () => {
    expect(readUiState()).toEqual(DEFAULT_UI_STATE);
    expect(DEFAULT_UI_STATE.activeTab).toBe("dashboard");
  });

  it("round-trips the tab a user left on", () => {
    writeUiState({ userId: "user-1", activeTab: "markets", agentSubTab: "risk" });
    expect(readUiState()).toEqual({ userId: "user-1", activeTab: "markets", agentSubTab: "risk" });
  });

  it("clearing returns the next read to the dashboard default", () => {
    writeUiState({ userId: "user-1", activeTab: "settings", agentSubTab: "chat" });
    clearUiState();
    expect(readUiState()).toEqual(DEFAULT_UI_STATE);
  });

  it("falls back to defaults for unknown tab values", () => {
    localStorage.setItem(
      "kta:ui-state:v1",
      JSON.stringify({ userId: "user-1", activeTab: "billing", agentSubTab: "nope" }),
    );
    const state = readUiState();
    expect(state.activeTab).toBe("dashboard");
    expect(state.agentSubTab).toBe("chat");
    expect(state.userId).toBe("user-1");
  });

  it("falls back to defaults for corrupt JSON", () => {
    localStorage.setItem("kta:ui-state:v1", "{not json");
    expect(readUiState()).toEqual(DEFAULT_UI_STATE);
  });

  it("reports the stored owner so another account's state can be discarded", () => {
    writeUiState({ userId: "user-1", activeTab: "agent", agentSubTab: "memory" });
    expect(readUiState().userId).toBe("user-1");
  });
});
