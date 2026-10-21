/** Hard limits. Decision JSON cannot override these. */
export const STARTING_CASH_CENTS = 10_000;
export const DAILY_LOSS_LIMIT_CENTS = 500;
export const RISK_PER_TRADE_CENTS = 100;

/**
 * All three of env, file, and --live must match this phrase before the CLI
 * even considers live mode. The CLI still refuses to send an order.
 */
export const LIVE_ENABLE_PHRASE = "I_EXPLICITLY_ENABLE_LIVE_MODE";

export const LIMITS = Object.freeze({
  startingCashCents: STARTING_CASH_CENTS,
  dailyLossLimitCents: DAILY_LOSS_LIMIT_CENTS,
  riskPerTradeCents: RISK_PER_TRADE_CENTS,
  maxLeverage: 1,
});
