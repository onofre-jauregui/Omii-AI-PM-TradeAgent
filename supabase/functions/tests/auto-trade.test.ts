import { describe, it, expect } from "vitest";
import {
  computePnl,
  resolveKalshiMarketAction,
  computeWinStreakFromTrades,
  s002VolumeCheck,
  s002EdgeCentsCheck,
  s002SlotWeight,
  s002IsAutoQualified,
  buildForceLlmCities,
  s005IsAutoQualified,
  buildQualifyEndpoint,
  buildQualifyHeaders,
} from "../_shared/trading-logic";
import { parseQualifyResponse } from "../_shared/prompt-safety";

// ─── S-002 Longshot Bias — signal filters ──────────────────────────────────

describe("S-002 signal filters", () => {
  // Volume floor: 150 (down from 200 — equity-options threshold over-filtered Kalshi market)
  it("signal with volume < 150 is filtered before LLM qualify call", () => {
    expect(s002VolumeCheck(149)).toBe(false);
  });

  it("signal with volume >= 150 passes volume check", () => {
    expect(s002VolumeCheck(150)).toBe(true);
    expect(s002VolumeCheck(500)).toBe(true);
  });

  it("spread guard: volume >= 150 but spread > 3¢ → rejected", () => {
    expect(s002VolumeCheck(200, 4)).toBe(false);
  });

  it("spread guard: volume >= 150 and spread <= 3¢ → passes", () => {
    expect(s002VolumeCheck(200, 3)).toBe(true);
    expect(s002VolumeCheck(200, 0)).toBe(true);
  });

  // Edge floor: 4¢ (up from 3¢ — 3¢ allowed setups below what the academic premise supports)
  it("signal with edge_cents < 4 → skipped, detail contains edge floor message", () => {
    const result = s002EdgeCentsCheck(3);
    expect(result.passes).toBe(false);
    expect(result.detail).toMatch(/skipped: edge_cents=3¢ below 4¢ floor/);
  });

  it("signal with edge_cents >= 4 → proceeds to qualify gate", () => {
    expect(s002EdgeCentsCheck(4).passes).toBe(true);
    expect(s002EdgeCentsCheck(10).passes).toBe(true);
  });

  it("signal with volume >= 150 AND edge_cents >= 4 → passes both filters", () => {
    expect(s002VolumeCheck(200)).toBe(true);
    expect(s002EdgeCentsCheck(5).passes).toBe(true);
  });

  // Slot weights: shorter duration = stronger bias signal = full slot weight
  it("slot weight: <= 3d → 1.0 (strongest bias signal)", () => {
    expect(s002SlotWeight(0.5)).toBe(1.0);
    expect(s002SlotWeight(3)).toBe(1.0);
  });

  it("slot weight: 3-7d → 0.75", () => {
    expect(s002SlotWeight(5)).toBe(0.75);
    expect(s002SlotWeight(7)).toBe(0.75);
  });

  it("slot weight: > 7d → 0.5 (weakest; far-term bias less supported)", () => {
    expect(s002SlotWeight(8)).toBe(0.5);
    expect(s002SlotWeight(30)).toBe(0.5);
  });

  // Auto-qualify bypass: mirrors S-005's high-confidence bypass
  it("auto-qualify: YES 8-10¢, vol >= 300, edge >= 6¢ → bypasses LLM", () => {
    expect(s002IsAutoQualified(9, 300, 6)).toBe(true);
    expect(s002IsAutoQualified(8, 400, 8)).toBe(true);
    expect(s002IsAutoQualified(10, 300, 6)).toBe(true);
  });

  it("auto-qualify: YES 11¢ → does not bypass (top of range, lower quality)", () => {
    expect(s002IsAutoQualified(11, 400, 8)).toBe(false);
  });

  it("auto-qualify: vol < 300 → does not bypass", () => {
    expect(s002IsAutoQualified(9, 299, 6)).toBe(false);
  });

  it("auto-qualify: edge < 6¢ → does not bypass", () => {
    expect(s002IsAutoQualified(9, 300, 5)).toBe(false);
  });
});

// ─── S-005 Weather Edge — loss-streak city gate ───────────────────────────────

describe("S-005 city gate", () => {
  const makeWinLoss = (entries: [string, { wins: number; losses: number }][]) =>
    new Map(entries.map(([city, s]) => [city, { ...s, totalPnl: 0 }]));

  it("city with 0 NO losses in 14d + edge >= 30¢ → auto-qualified (LLM not called)", () => {
    const cityWinLoss = makeWinLoss([["miami", { wins: 3, losses: 0 }]]);
    const forced = buildForceLlmCities(cityWinLoss);
    expect(s005IsAutoQualified(30, "miami", forced)).toBe(true);
  });

  it("city with 5 losses + 83% loss rate → forced through LLM gate (strong bias signal)", () => {
    const cityWinLoss = makeWinLoss([["miami", { wins: 1, losses: 5 }]]);
    const forced = buildForceLlmCities(cityWinLoss);
    expect(s005IsAutoQualified(30, "miami", forced)).toBe(false);
  });

  it("city with 3 losses but only 43% loss rate → NOT forced (normal variance, not bias)", () => {
    const cityWinLoss = makeWinLoss([["miami", { wins: 4, losses: 3 }]]);
    const forced = buildForceLlmCities(cityWinLoss);
    expect(s005IsAutoQualified(30, "miami", forced)).toBe(true);
  });

  it("city with 4 NO losses in 14d + edge < 30¢ → LLM gate (below auto-qualify threshold)", () => {
    const cityWinLoss = makeWinLoss([["lax", { wins: 0, losses: 4 }]]);
    const forced = buildForceLlmCities(cityWinLoss);
    expect(s005IsAutoQualified(20, "lax", forced)).toBe(false);
  });

  it("forceLlmCities requires both >= 5 losses AND >= 60% loss rate", () => {
    const cityWinLoss = makeWinLoss([
      ["miami", { wins: 0, losses: 6 }],   // 100% loss rate, 6 losses → forced
      ["lax",   { wins: 3, losses: 5 }],   // 63% loss rate, 5 losses → forced
      ["nyc",   { wins: 0, losses: 4 }],   // 100% but only 4 losses → not forced
      ["chi",   { wins: 5, losses: 5 }],   // 5 losses but only 50% → not forced
    ]);
    const forced = buildForceLlmCities(cityWinLoss);
    expect(forced.has("miami")).toBe(true);
    expect(forced.has("lax")).toBe(true);
    expect(forced.has("nyc")).toBe(false);
    expect(forced.has("chi")).toBe(false);
  });
});

// ─── computeWinStreak ─────────────────────────────────────────────────────────

describe("computeWinStreakFromTrades", () => {
  // Use a fixed "now" so tests don't depend on the current date.
  // "today" is treated as 2026-05-31 noon UTC.
  const NOW_MS = new Date("2026-05-31T12:00:00Z").getTime();

  it("returns 0 with no settled trades", () => {
    expect(computeWinStreakFromTrades([], NOW_MS)).toBe(0);
  });

  it("returns 3 for 3 consecutive calendar days with positive net P&L", () => {
    const trades = [
      { settled_at: "2026-05-31T10:00:00Z", pnl: 2.5 },
      { settled_at: "2026-05-30T15:00:00Z", pnl: 1.8 },
      { settled_at: "2026-05-29T09:00:00Z", pnl: 3.1 },
    ];
    expect(computeWinStreakFromTrades(trades, NOW_MS)).toBe(3);
  });

  it("resets to 0 when any day has negative net P&L", () => {
    const trades = [
      { settled_at: "2026-05-31T10:00:00Z", pnl: 2.0 },
      { settled_at: "2026-05-30T10:00:00Z", pnl: -1.0 }, // loss day
      { settled_at: "2026-05-29T10:00:00Z", pnl: 3.0 },
    ];
    // Only today is positive; May-30 is negative → streak = 1
    expect(computeWinStreakFromTrades(trades, NOW_MS)).toBe(1);
  });

  it("resets to 0 when there is a calendar gap (non-consecutive profitable days)", () => {
    const trades = [
      { settled_at: "2026-05-31T10:00:00Z", pnl: 2.0 },
      // May 30 missing — gap
      { settled_at: "2026-05-29T10:00:00Z", pnl: 3.0 },
    ];
    expect(computeWinStreakFromTrades(trades, NOW_MS)).toBe(1);
  });

  it("uses settled_at, not created_at, for day boundaries", () => {
    // All settled on same day (May-31) → counts as 1 day
    const trades = [
      { settled_at: "2026-05-31T08:00:00Z", pnl: 1.0 },
      { settled_at: "2026-05-31T18:00:00Z", pnl: 2.0 },
    ];
    expect(computeWinStreakFromTrades(trades, NOW_MS)).toBe(1);
  });
});

// ─── auto-settle terminal status handling ─────────────────────────────────────

describe("resolveKalshiMarketAction", () => {
  it("status='settled' + result='yes' → settle", () => {
    expect(resolveKalshiMarketAction("settled", "yes")).toBe("settle");
  });

  it("status='settled' + result='no' → settle", () => {
    expect(resolveKalshiMarketAction("settled", "no")).toBe("settle");
  });

  it("status='finalized' + result='yes' → settle (same code path as settled)", () => {
    expect(resolveKalshiMarketAction("finalized", "yes")).toBe("settle");
  });

  it("status='closed' + result='yes' → settle with P&L", () => {
    expect(resolveKalshiMarketAction("closed", "yes")).toBe("settle");
  });

  it("status='voided' → void", () => {
    expect(resolveKalshiMarketAction("voided")).toBe("void");
  });

  it("status='cancelled' → void", () => {
    expect(resolveKalshiMarketAction("cancelled")).toBe("void");
  });

  it("status='active', no result → skipped", () => {
    expect(resolveKalshiMarketAction("active")).toBe("skip");
    expect(resolveKalshiMarketAction("active", "")).toBe("skip");
  });

  it("P&L math: NO position at 90¢ cost, $20 stake, market resolves NO → pnl ≈ +$2.22", () => {
    // NO position: side="no", action="buy", price=90¢, amount=$20, result="no"
    // contracts = 20 / 0.90 ≈ 22.22; pnl = contracts * (1 - 0.90) = 22.22 * 0.10 ≈ 2.22
    const { pnl, outcome } = computePnl("no", "buy", 90, 20, "no");
    expect(outcome).toBe("win");
    expect(pnl).toBeCloseTo(2.22, 1);
  });
});

// ─── LLM gate — qualifySetup routing ─────────────────────────────────────────

describe("LLM gate routing", () => {
  it("provider='anthropic' → endpoint is /messages", () => {
    const endpoint = buildQualifyEndpoint("anthropic", "https://api.anthropic.com/v1");
    expect(endpoint).toBe("https://api.anthropic.com/v1/messages");
  });

  it("provider='anthropic' → headers include anthropic-version", () => {
    const headers = buildQualifyHeaders("anthropic", "sk-test");
    expect(headers["anthropic-version"]).toBeDefined();
  });

  it("provider='openrouter' → endpoint is /chat/completions", () => {
    const endpoint = buildQualifyEndpoint("openrouter", "https://openrouter.ai/api/v1");
    expect(endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("provider='openrouter' → headers include HTTP-Referer", () => {
    const headers = buildQualifyHeaders("openrouter", "sk-test");
    expect(headers["HTTP-Referer"]).toBeDefined();
  });

  it("response text 'QUALIFY\\nReason: ...' → decision=QUALIFY", () => {
    const parsed = parseQualifyResponse("QUALIFY\nReason: strong structural edge");
    expect(parsed?.decision).toBe("QUALIFY");
  });

  it("response text 'REJECT\\nReason: ...' → decision=REJECT", () => {
    const parsed = parseQualifyResponse("REJECT\nReason: market expires in 30 minutes");
    expect(parsed?.decision).toBe("REJECT");
  });

  it("malformed response → null (treated as REJECT by caller)", () => {
    expect(parseQualifyResponse("maybe qualify this")).toBeNull();
  });
});
