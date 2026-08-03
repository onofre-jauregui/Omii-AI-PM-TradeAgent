import { describe, expect, it } from "vitest";
import {
  applyLessonDedupeFilters,
  type LessonIdentity,
  lessonDedupeTags,
} from "./lesson-dedupe.ts";

/** Chainable stand-in for a PostgREST builder that records every filter applied. */
function recordingQuery() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = { calls };
  for (const op of ["eq", "is", "contains", "gte"]) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return builder;
    };
  }
  return builder as { calls: typeof calls } & Record<string, never>;
}

const SINCE = "2026-07-27T00:00:00.000Z";

const lossOnBtc: LessonIdentity = {
  tickerBase: "kxbtc",
  outcome: "loss",
  strategyId: "s-001-ea207ba1",
  userId: "ea207ba1-b7a9-4a7b-96bc-922e922d627d",
};

describe("lessonDedupeTags", () => {
  it("requires the outcome tag alongside the ticker family", () => {
    expect(lessonDedupeTags(lossOnBtc)).toEqual(["kxbtc", "loss"]);
  });

  it("distinguishes a win from a loss on the same ticker family", () => {
    const win = { ...lossOnBtc, outcome: "win" };
    expect(lessonDedupeTags(win)).not.toEqual(lessonDedupeTags(lossOnBtc));
  });
});

describe("applyLessonDedupeFilters", () => {
  it("scopes by outcome so a loss can never merge into a win memory", () => {
    const q = recordingQuery();
    applyLessonDedupeFilters(q, lossOnBtc, SINCE);

    const containsCall = q.calls.find((c) => c.op === "contains");
    expect(containsCall).toBeDefined();
    // The 2026-08-01 regression: this filter was ["kxbtc"] alone, so a $22 loss
    // matched — and rewrote — a memory tagged "win" with 27 confirmations.
    expect(containsCall!.args[1]).toEqual(["kxbtc", "loss"]);
  });

  it("scopes by owner and strategy so tenants cannot merge into each other", () => {
    const q = recordingQuery();
    applyLessonDedupeFilters(q, lossOnBtc, SINCE);

    const eqPairs = q.calls
      .filter((c) => c.op === "eq")
      .map((c) => [c.args[0], c.args[1]]);
    expect(eqPairs).toContainEqual([
      "user_id",
      "ea207ba1-b7a9-4a7b-96bc-922e922d627d",
    ]);
    expect(eqPairs).toContainEqual(["strategy_id", "s-001-ea207ba1"]);
  });

  it("matches NULL owner with IS NULL rather than an equality on undefined", () => {
    const q = recordingQuery();
    applyLessonDedupeFilters(q, { ...lossOnBtc, userId: null, strategyId: null }, SINCE);

    const isPairs = q.calls
      .filter((c) => c.op === "is")
      .map((c) => [c.args[0], c.args[1]]);
    expect(isPairs).toContainEqual(["user_id", null]);
    expect(isPairs).toContainEqual(["strategy_id", null]);
    expect(q.calls.filter((c) => c.op === "eq").map((c) => c.args[0]))
      .not.toContain("user_id");
  });

  it("still bounds the lookup to the recency window", () => {
    const q = recordingQuery();
    applyLessonDedupeFilters(q, lossOnBtc, SINCE);
    expect(q.calls.find((c) => c.op === "gte")!.args).toEqual([
      "created_at",
      SINCE,
    ]);
  });
});
