import { describe, it, expect } from "vitest";
import { isServiceRoleBearer } from "./auth-helpers";

describe("isServiceRoleBearer", () => {
  it("returns true when bearer exactly matches the service key", () => {
    const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service-role.sig";
    expect(isServiceRoleBearer(key, key)).toBe(true);
  });

  it("returns false when bearer differs from service key", () => {
    expect(isServiceRoleBearer("attacker-supplied-uuid", "real-service-key")).toBe(false);
  });

  it("returns false when service key is undefined (no env var set)", () => {
    expect(isServiceRoleBearer("some-token", undefined)).toBe(false);
  });

  it("returns false for empty bearer string", () => {
    expect(isServiceRoleBearer("", "real-service-key")).toBe(false);
  });

  it("returns false for empty service key", () => {
    expect(isServiceRoleBearer("some-token", "")).toBe(false);
  });
});
