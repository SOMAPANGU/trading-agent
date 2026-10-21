import { LIMITS } from "./constants.js";
import { TradingError } from "./errors.js";

export function usdToCents(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd)) {
    throw new TradingError("bad_notional", "notionalUsd must be a finite number");
  }
  const cents = Math.round(usd * 100);
  if (cents <= 0) {
    throw new TradingError("bad_notional", "notionalUsd must be positive");
  }
  return cents;
}

export function unrealizedPnlCents(position, mark) {
  assertPrice(mark, "mark");
  const diff =
    position.side === "long"
      ? mark - position.entryPrice
      : position.entryPrice - mark;
  return Math.round((diff / position.entryPrice) * position.notionalCents);
}

export function equityCents(state, marks) {
  let equity = state.cashCents;
  for (const position of state.positions) {
    const mark = marks.get(position.symbol);
    if (mark == null) {
      throw new TradingError(
        "missing_mark",
        `no price for open position ${position.symbol}`,
      );
    }
    equity += position.marginCents + unrealizedPnlCents(position, mark);
  }
  return equity;
}

/**
 * Loss planned if the stop fills, rounded up so the limit cannot be understated.
 * Stop must sit on the protective side of the entry.
 */
export function plannedRiskCents({ side, entryPrice, stopPrice, notionalCents }) {
  assertPrice(entryPrice, "entry");
  assertPrice(stopPrice, "stop");
  if (!Number.isInteger(notionalCents) || notionalCents <= 0) {
    throw new TradingError("bad_notional", "notional must be positive integer cents");
  }
  if (side === "long" && !(stopPrice < entryPrice)) {
    throw new TradingError("bad_stop", "a long stop must be below the entry price");
  }
  if (side === "short" && !(stopPrice > entryPrice)) {
    throw new TradingError("bad_stop", "a short stop must be above the entry price");
  }
  const distance = Math.abs(entryPrice - stopPrice) / entryPrice;
  const risk = Math.ceil(distance * notionalCents - 1e-9);
  if (risk < 1) {
    throw new TradingError("stop_too_tight", "stop distance rounds to zero risk");
  }
  return risk;
}

export function assertWithinRiskLimits({ drawdownCents, riskCents }) {
  if (riskCents > LIMITS.riskPerTradeCents) {
    throw new TradingError(
      "risk_per_trade",
      `planned loss ${cents(riskCents)} exceeds ${cents(LIMITS.riskPerTradeCents)} per trade`,
    );
  }
  if (drawdownCents >= LIMITS.dailyLossLimitCents) {
    throw new TradingError(
      "daily_loss_limit",
      `daily loss ${cents(drawdownCents)} has reached ${cents(LIMITS.dailyLossLimitCents)}`,
    );
  }
  if (drawdownCents + riskCents > LIMITS.dailyLossLimitCents) {
    throw new TradingError(
      "daily_loss_limit",
      `planned loss ${cents(riskCents)} would push daily loss past ${cents(LIMITS.dailyLossLimitCents)}`,
    );
  }
}

export function cents(amount) {
  return `$${(amount / 100).toFixed(2)}`;
}

function assertPrice(price, label) {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1e12) {
    throw new TradingError("bad_price", `${label} price must be a positive finite number`);
  }
}
