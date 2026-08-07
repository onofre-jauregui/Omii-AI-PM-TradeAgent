import { describe, expect, it } from "vitest";
import { bannerBottomOffset } from "./swUpdateBanner";

describe("bannerBottomOffset", () => {
  it("clears the bottom nav and the safe-area inset when a nav is mounted", () => {
    // The regression this guards: at a bare 1rem the banner sat inside the 56px
    // nav strip and, at z-index 9999, intercepted every tap on the middle tabs.
    expect(bannerBottomOffset(56)).toBe("calc(1rem + 56px + env(safe-area-inset-bottom, 0px))");
  });

  it("rounds a fractional measured height up so it never lands a pixel short", () => {
    expect(bannerBottomOffset(55.4)).toContain("56px");
  });

  it("sits at the plain gap when no bottom nav is mounted", () => {
    expect(bannerBottomOffset(0)).toBe("1rem");
  });

  it("falls back to the plain gap for a missing or nonsense measurement", () => {
    expect(bannerBottomOffset(Number.NaN)).toBe("1rem");
    expect(bannerBottomOffset(-10)).toBe("1rem");
  });
});
