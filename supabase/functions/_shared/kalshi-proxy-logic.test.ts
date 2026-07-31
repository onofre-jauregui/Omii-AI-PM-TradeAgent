import { describe, it, expect } from "vitest";
import { isAllowedProxyRequest } from "./kalshi-proxy-logic.ts";

// Regression lock for the 2026-07-30 production-readiness audit finding:
// kalshi-proxy had no endpoint allowlist and would sign+forward ANY
// method/endpoint with the caller's own Kalshi credentials, including
// POST/PUT portfolio/orders (place a real live order) and bulk DELETE
// portfolio/orders — completely bypassing execute-trade's server-side risk
// enforcement. DESIGN-REPORT.md §6 finding #1.

describe("isAllowedProxyRequest", () => {
  describe("GET — read-only browsing", () => {
    it.each([
      ["markets", "markets"],
      ["markets/KXFED-27APR", "single market lookup"],
      ["markets?limit=50&status=open", "markets with query string"],
      ["series", "series list"],
      ["series?category=Sports", "series with query string"],
      ["events", "events list"],
      ["portfolio/balance", "balance"],
      ["portfolio/positions", "positions"],
      ["portfolio/orders", "orders list"],
      ["portfolio/orders?status=open", "orders list with query string"],
      ["portfolio/fills", "fills"],
      ["portfolio/fills?limit=50", "fills with query string"],
    ])("allows GET %s (%s)", (endpoint) => {
      expect(isAllowedProxyRequest("GET", endpoint)).toBe(true);
    });

    it("rejects a GET endpoint outside the allowlist", () => {
      expect(isAllowedProxyRequest("GET", "portfolio/settlements")).toBe(false);
      expect(isAllowedProxyRequest("GET", "exchange/schedule")).toBe(false);
    });

    it("does not allow a prefix-adjacent endpoint that merely starts with an allowed word", () => {
      // "marketsxyz" should not match the "markets" prefix rule
      expect(isAllowedProxyRequest("GET", "marketsxyz")).toBe(false);
    });
  });

  describe("DELETE — single resting-order cancellation only", () => {
    it("allows cancelling a single order by id", () => {
      expect(isAllowedProxyRequest("DELETE", "portfolio/orders/abc-123")).toBe(true);
    });

    it("rejects a bulk cancel (no order id)", () => {
      expect(isAllowedProxyRequest("DELETE", "portfolio/orders")).toBe(false);
    });

    it("rejects a bulk cancel scoped by query string instead of a path id", () => {
      expect(isAllowedProxyRequest("DELETE", "portfolio/orders?ticker=KXFED-27APR")).toBe(false);
    });

    it("rejects DELETE on any other endpoint", () => {
      expect(isAllowedProxyRequest("DELETE", "portfolio/positions")).toBe(false);
    });
  });

  describe("POST/PUT — order placement never allowed through this proxy", () => {
    it("rejects POST portfolio/orders (the core bypass this closes)", () => {
      expect(isAllowedProxyRequest("POST", "portfolio/orders")).toBe(false);
    });

    it("rejects PUT portfolio/orders", () => {
      expect(isAllowedProxyRequest("PUT", "portfolio/orders")).toBe(false);
    });

    it("rejects POST to any endpoint, even ones GET allows", () => {
      expect(isAllowedProxyRequest("POST", "markets")).toBe(false);
      expect(isAllowedProxyRequest("PUT", "portfolio/balance")).toBe(false);
    });
  });
});
