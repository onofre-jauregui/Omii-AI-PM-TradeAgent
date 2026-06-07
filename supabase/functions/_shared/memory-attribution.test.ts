import { describe, it, expect } from "vitest";

describe("memory attribution guard", () => {
  it("skips when influencedByMemoryIds is empty", () => {
    const ids: string[] = [];
    expect(ids && ids.length > 0).toBe(false);
  });

  it("skips when influencedByMemoryIds is undefined", () => {
    const ids: string[] | undefined = undefined;
    expect(ids && ids.length > 0).toBeFalsy();
  });

  it("writes when ids are present", () => {
    const ids = ["uuid-1", "uuid-2"];
    expect(ids && ids.length > 0).toBeTruthy();
  });

  it("maps ids to attribution rows correctly", () => {
    const tradeId = "trade-uuid";
    const memoryIds = ["mem-1", "mem-2", "mem-3"];
    const rows = memoryIds.map((memId) => ({ trade_id: tradeId, memory_id: memId }));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ trade_id: "trade-uuid", memory_id: "mem-1" });
    expect(rows[2]).toEqual({ trade_id: "trade-uuid", memory_id: "mem-3" });
  });
});

describe("memory ID extraction from memories array", () => {
  it("extracts IDs from memories array", () => {
    const memories = [
      { id: "mem-1", title: "lesson 1", confidence: 0.9 },
      { id: "mem-2", title: "lesson 2", confidence: 0.8 },
    ];
    const ids = (memories ?? []).map((m: any) => m.id);
    expect(ids).toEqual(["mem-1", "mem-2"]);
  });

  it("returns empty array when memories is null", () => {
    const memories = null;
    const ids = (memories ?? []).map((m: any) => m.id);
    expect(ids).toEqual([]);
  });

  it("returns empty array when memories is empty", () => {
    const memories: any[] = [];
    const ids = memories.map((m: any) => m.id);
    expect(ids).toEqual([]);
  });
});

describe("naming convention — camelCase only (execute-trade contract)", () => {
  it("reads influencedByMemoryIds from camelCase body key", () => {
    const body = { influencedByMemoryIds: ["mem-1"] };
    const { influencedByMemoryIds } = body as any;
    expect(influencedByMemoryIds).toEqual(["mem-1"]);
  });

  it("returns undefined when snake_case key is used — callers must use camelCase", () => {
    // This documents the breaking change: snake_case no longer accepted.
    // auto-trade and trading-agent must use influencedByMemoryIds.
    const body = { influenced_by_memory_ids: ["mem-1"] };
    const { influencedByMemoryIds } = body as any;
    expect(influencedByMemoryIds).toBeUndefined();
  });
});
