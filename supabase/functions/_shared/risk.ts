/**
 * Pure risk-management evaluation. No I/O, no Deno imports — safe to run
 * under Vitest (Node) and Deno (edge functions).
 *
 * The caller is responsible for:
 *  - Loading risk_settings and risk_state from Supabase
 *  - Persisting compliance_log entries based on the result
 *  - Writing risk_state updates after a fill
 *
 * This module only answers the question: "given these inputs, should this
 * order be allowed through?"
 */

export interface RiskSettings {
  max_position_size: number;
  max_daily_loss: number;
  max_open_positions: number;
  max_drawdown_pct: number;
}

export interface RiskState {
  date: string;
  is_trading_halted: boolean;
  halt_reason: string | null;
  daily_pnl: number;
  open_position_count: number;
  peak_portfolio_value: number;
}

export type RiskRejectionCode =
  | "position_size"
  | "trading_halted"
  | "daily_loss_limit"
  | "open_positions_limit"
  | "drawdown_limit"
  | "concentration_limit";

export interface RiskEvaluationResult {
  passed: boolean;
  reason?: string;
  code?: RiskRejectionCode;
  /** When the evaluation determines trading should be halted going forward */
  newHaltReason?: string;
}

/**
 * Pure evaluation of whether a proposed order passes risk checks.
 *
 * Paper mode bypasses all checks. Live mode runs the full gauntlet.
 *
 * Order of checks matches the production policy in execute-trade:
 *  1. position size
 *  2. trading halted state
 *  3. daily loss limit
 *  4. open positions limit
 *  5. drawdown limit
 *  6. single-order concentration (>25% of peak portfolio)
 */
export function evaluateRisk(
  amount: number,
  mode: "paper" | "live",
  settings: RiskSettings | null,
  riskState: RiskState | null
): RiskEvaluationResult {
  if (mode === "paper") return { passed: true };
  if (!settings) return { passed: true };

  // 1. Position size
  if (amount > settings.max_position_size) {
    return {
      passed: false,
      code: "position_size",
      reason: `Order amount $${amount} exceeds max position size $${settings.max_position_size}`,
    };
  }

  if (!riskState) return { passed: true };

  // 2. Trading already halted
  if (riskState.is_trading_halted) {
    return {
      passed: false,
      code: "trading_halted",
      reason: `Trading halted: ${riskState.halt_reason || "daily limits exceeded"}`,
    };
  }

  // 3. Daily loss limit
  if (
    Math.abs(riskState.daily_pnl) >= settings.max_daily_loss &&
    riskState.daily_pnl < 0
  ) {
    return {
      passed: false,
      code: "daily_loss_limit",
      reason: `Daily loss limit of $${settings.max_daily_loss} reached. Trading halted for today.`,
      newHaltReason: `Daily loss limit of $${settings.max_daily_loss} reached`,
    };
  }

  // 4. Max open positions
  if (riskState.open_position_count >= settings.max_open_positions) {
    return {
      passed: false,
      code: "open_positions_limit",
      reason: `Maximum open positions (${settings.max_open_positions}) reached. Close a position first.`,
    };
  }

  // 5. Drawdown limit
  if (riskState.peak_portfolio_value > 0 && riskState.daily_pnl < 0) {
    const currentValue = riskState.peak_portfolio_value + riskState.daily_pnl;
    const drawdownPct =
      ((riskState.peak_portfolio_value - currentValue) /
        riskState.peak_portfolio_value) *
      100;
    if (drawdownPct >= settings.max_drawdown_pct) {
      return {
        passed: false,
        code: "drawdown_limit",
        reason: `Max drawdown of ${settings.max_drawdown_pct}% exceeded (current: ${drawdownPct.toFixed(1)}%). Trading halted.`,
        newHaltReason: `Max drawdown of ${settings.max_drawdown_pct}% exceeded (current drawdown: ${drawdownPct.toFixed(1)}%)`,
      };
    }
  }

  // 6. Single-order concentration: no trade > 25% of peak portfolio value
  if (riskState.peak_portfolio_value > 0) {
    const concentrationPct = (amount / riskState.peak_portfolio_value) * 100;
    if (concentrationPct > 25) {
      return {
        passed: false,
        code: "concentration_limit",
        reason: `Order amount $${amount} exceeds 25% portfolio concentration limit (portfolio: $${riskState.peak_portfolio_value}).`,
      };
    }
  }

  return { passed: true };
}
