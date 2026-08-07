import { describe, it, expect } from "vitest";
import { buildSeededStrategies, DISABLED_BY_DEFAULT_TEMPLATES } from "./onboardingSeed";

const USER_ID = "ea207ba1-4c2f-4d1e-9a3b-7f6e5d4c3b2a";

describe("onboarding strategy seed", () => {
  it("never seeds a negative-expectancy strategy active", () => {
    // The guard that matters. S-005 shipped active while running a −$6.45/trade
    // expectancy, which put every new account into a suspend/auto-resume loss loop.
    const seeded = buildSeededStrategies(USER_ID);

    for (const template of DISABLED_BY_DEFAULT_TEMPLATES) {
      const row = seeded.find((s) => s.template_id === template);
      expect(row, `${template} must be present in the seed`).toBeDefined();
      expect(row!.active, `${template} must be seeded inactive`).toBe(false);
    }
  });

  it("seeds S-001 active as the only default-on strategy", () => {
    const active = buildSeededStrategies(USER_ID).filter((s) => s.active);
    expect(active.map((s) => s.template_id)).toEqual(["S-001"]);
  });

  it("scopes every seeded row to the user and starts them in paper mode", () => {
    // Live mode is never a seed default — a new account must not place real
    // orders before it has funded and reviewed anything.
    for (const row of buildSeededStrategies(USER_ID)) {
      expect(row.user_id).toBe(USER_ID);
      expect(row.mode).toBe("paper");
      expect(row.starting_balance).toBeGreaterThan(0);
    }
  });

  it("derives collision-resistant per-user ids from the uuid", () => {
    const seeded = buildSeededStrategies(USER_ID);
    expect(seeded.map((s) => s.id)).toEqual([
      "S-001-ea207ba1",
      "S-002-ea207ba1",
      "S-005-ea207ba1",
    ]);

    // A different user must not collide onto the same row via the upsert's onConflict: "id".
    const other = buildSeededStrategies("00000000-1111-2222-3333-444444444444");
    expect(other.map((s) => s.id)).not.toEqual(seeded.map((s) => s.id));
  });
});
