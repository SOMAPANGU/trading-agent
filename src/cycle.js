import { LIMITS } from "./constants.js";
import { TradingError } from "./errors.js";
import { utcDate } from "./ledger.js";
import { preflight } from "./preflight.js";
import {
  assertWithinRiskLimits,
  equityCents,
  plannedRiskCents,
  unrealizedPnlCents,
  usdToCents,
} from "./risk.js";

/**
 * Apply one paper decision to a cloned ledger.
 * Prices come from the snapshot. Risk limits come from constants.js.
 * This function cannot place a live order.
 */
export function runCycle(previous, input) {
  if (previous?.mode !== "paper") {
    throw new TradingError("live_disabled", "only the paper ledger can be updated");
  }
  const state = structuredClone(previous);
  try {
    return execute(state, input);
  } catch (error) {
    if (!(error instanceof TradingError)) throw error;
    return finish(state, {
      at: typeof input?.now === "string" ? input.now : null,
      action: input?.decision?.action || "hold",
      symbol: input?.decision?.symbol || null,
      reason: typeof input?.decision?.reason === "string" ? input.decision.reason : error.message,
      status: "rejected",
      code: error.code,
      detail: error.message,
      mode: "paper",
      limits: LIMITS,
    });
  }
}

function execute(state, input) {
  const at = input.now;
  const day = utcDate(at);
  const report = preflight(input.tools);
  const decision = normalizeDecision(input.decision);
  const markets = indexMarkets(input.markets);
  const quiverBySymbol = indexQuiver(input.quiver);
  const base = {
    at,
    action: decision.action,
    symbol: decision.symbol,
    reason: decision.reason,
    mode: "paper",
    preflight: report,
    limits: LIMITS,
  };

  if (!report.ok) {
    return finish(state, {
      ...base,
      status: decision.action === "hold" ? "held" : "rejected",
      code: "mcp_unavailable",
      detail: "Liquid Co-Invest research tools were not in this run's tool catalog",
    });
  }

  const marks = marksFor(state, markets);
  if (state.day.utcDate !== day) {
    const baseline = state.lastMarkedEquityCents ?? equityCents(state, marks);
    state.day = { utcDate: day, startEquityCents: baseline };
  }

  const automaticStops = [];
  if (report.ok) {
    for (const position of [...state.positions]) {
      const mark = marks.get(position.symbol);
      const hit =
        (position.side === "long" && mark <= position.stopPrice) ||
        (position.side === "short" && mark >= position.stopPrice);
      if (!hit) continue;
      const trade = realizeClose(state, position, mark, at, "stop_loss");
      const row = finish(state, {
        at,
        action: "close",
        symbol: position.symbol,
        reason: "stop_loss",
        status: "filled",
        code: "stop_loss",
        mode: "paper",
        automatic: true,
        price: mark,
        pnlCents: trade.pnlCents,
        tradeId: trade.id,
      });
      automaticStops.push({
        symbol: position.symbol,
        pnlCents: trade.pnlCents,
        decisionId: row.result.id,
      });
    }
    rememberMark(state, markets);
  }

  if (decision.action === "hold") {
    rememberMark(state, markets);
    return finish(state, {
      ...base,
      status: "held",
      code: report.ok ? "hold" : "mcp_unavailable",
      detail: decision.reason,
      automaticStops,
    });
  }

  assertScan(markets);
  if (decision.action === "close") {
    const closed = applyClose(state, decision, markets, at);
    rememberMark(state, markets);
    return finish(state, {
      ...base,
      status: "filled",
      code: "closed",
      side: closed.side,
      price: closed.price,
      pnlCents: closed.pnlCents,
      tradeId: closed.tradeId,
      automaticStops,
    });
  }

  const opened = applyOpen(state, decision, markets, quiverBySymbol, at);
  rememberMark(state, markets);
  return finish(state, {
    ...base,
    status: "filled",
    code: "opened",
    ...opened,
    automaticStops,
  });
}

function applyOpen(state, decision, markets, quiverBySymbol, at) {
  const market = requireMarket(markets, decision.symbol);
  if (state.positions.some((position) => position.symbol === market.symbol)) {
    throw new TradingError("position_exists", `${market.symbol} is already open; close it first`);
  }
  if ((decision.leverage ?? 1) !== 1) {
    throw new TradingError("leverage_disabled", "paper account is cash-only, leverage must be 1");
  }
  const side = decision.action === "buy" ? "long" : "short";
  const notionalCents = usdToCents(decision.notionalUsd);
  if (notionalCents > state.cashCents) {
    throw new TradingError("insufficient_cash", "notional exceeds cash; leverage is disabled");
  }
  const riskCents = plannedRiskCents({
    side,
    entryPrice: market.price,
    stopPrice: decision.stopPrice,
    notionalCents,
  });
  const drawdownCents = state.day.startEquityCents - equityCents(state, marksFor(state, markets));
  assertWithinRiskLimits({ drawdownCents, riskCents });

  const quiver = quiverBySymbol.get(market.symbol) || null;
  state.cashCents -= notionalCents;
  const position = {
    symbol: market.symbol,
    assetClass: market.assetClass,
    side,
    entryPrice: market.price,
    stopPrice: decision.stopPrice,
    notionalCents,
    marginCents: notionalCents,
    riskCents,
    openedAt: at,
  };
  state.positions.push(position);
  const trade = appendTrade(state, {
    at,
    effect: "open",
    price: market.price,
    pnlCents: 0,
    position,
    reason: decision.reason,
  });
  return {
    side,
    price: market.price,
    notionalCents,
    riskCents,
    quiverAvailable: quiver != null,
    quiverUsed: Boolean(decision.usedQuiver) && quiver != null,
    quiverWarning: decision.usedQuiver && !quiver ? "quiver_not_available" : null,
    quiver: quiver ? { symbol: quiver.symbol, summary: quiver.summary } : null,
    tradeId: trade.id,
  };
}

function applyClose(state, decision, markets, at) {
  if (decision.notionalUsd != null) {
    throw new TradingError("partial_close_disabled", "close exits the full position");
  }
  const market = requireMarket(markets, decision.symbol);
  const position = state.positions.find((item) => item.symbol === market.symbol);
  if (!position) throw new TradingError("no_position", `no open position for ${market.symbol}`);
  const trade = realizeClose(state, position, market.price, at, decision.reason);
  return { side: position.side, price: market.price, pnlCents: trade.pnlCents, tradeId: trade.id };
}

function realizeClose(state, position, price, at, reason) {
  const pnlCents = unrealizedPnlCents(position, price);
  state.cashCents += position.marginCents + pnlCents;
  state.positions = state.positions.filter((item) => item.symbol !== position.symbol);
  return appendTrade(state, {
    at,
    effect: "close",
    price,
    pnlCents,
    position,
    reason,
  });
}

function appendTrade(state, { at, effect, price, pnlCents, position, reason }) {
  const trade = {
    id: nextId(state),
    at,
    mode: "paper",
    effect,
    symbol: position.symbol,
    assetClass: position.assetClass,
    side: position.side,
    price,
    notionalCents: position.notionalCents,
    pnlCents,
    riskCents: position.riskCents,
    reason,
    cashCentsAfter: state.cashCents,
  };
  state.trades.push(trade);
  return trade;
}

function finish(state, fields) {
  const result = { id: nextId(state), ...fields };
  state.decisions.push(result);
  if (fields.at) state.updatedAt = fields.at;
  return { state, result };
}

function rememberMark(state, markets) {
  state.lastMarkedEquityCents = equityCents(state, marksFor(state, markets));
}

function nextId(state) {
  state.seq += 1;
  return state.seq;
}

function normalizeDecision(decision) {
  if (!decision || typeof decision !== "object") {
    throw new TradingError("bad_decision", "decision object is required");
  }
  const action = String(decision.action || "").trim().toLowerCase();
  if (!["buy", "sell", "close", "hold"].includes(action)) {
    throw new TradingError("bad_decision", "action must be buy, sell, close, or hold");
  }
  const reason = String(decision.reason || "").trim();
  if (!reason || reason.length > 2000) {
    throw new TradingError("bad_decision", "reason must be 1 to 2000 characters");
  }
  return {
    action,
    symbol: decision.symbol == null ? null : String(decision.symbol).trim(),
    reason,
    notionalUsd: decision.notionalUsd ?? null,
    stopPrice: decision.stopPrice,
    leverage: decision.leverage,
    usedQuiver: Boolean(decision.usedQuiver),
  };
}

function indexMarkets(markets) {
  if (!Array.isArray(markets)) throw new TradingError("bad_snapshot", "markets must be an array");
  const map = new Map();
  for (const market of markets) {
    const symbol = String(market?.symbol || "").trim();
    const assetClass = market?.assetClass;
    if (!symbol) throw new TradingError("bad_snapshot", "market symbol is required");
    if (assetClass !== "stock" && assetClass !== "crypto") {
      throw new TradingError("bad_snapshot", `${symbol} assetClass must be stock or crypto`);
    }
    if (typeof market.price !== "number" || !Number.isFinite(market.price) || market.price <= 0) {
      throw new TradingError("bad_snapshot", `${symbol} price is invalid`);
    }
    if (map.has(symbol)) throw new TradingError("bad_snapshot", `duplicate symbol ${symbol}`);
    map.set(symbol, { symbol, assetClass, price: market.price });
  }
  return map;
}

function indexQuiver(notes) {
  const map = new Map();
  if (notes == null) return map;
  if (!Array.isArray(notes)) throw new TradingError("bad_snapshot", "quiver must be an array");
  for (const note of notes) {
    const symbol = String(note?.symbol || "").trim();
    const summary = String(note?.summary || "").trim();
    if (!symbol || !summary) {
      throw new TradingError("bad_snapshot", "quiver notes need a symbol and summary");
    }
    map.set(symbol, { symbol, summary: summary.slice(0, 2000) });
  }
  return map;
}

function assertScan(markets) {
  const classes = new Set([...markets.values()].map((market) => market.assetClass));
  if (!classes.has("stock") || !classes.has("crypto")) {
    throw new TradingError(
      "incomplete_market_scan",
      "snapshot must include at least one stock-linked market and one crypto market",
    );
  }
}

function requireMarket(markets, symbol) {
  if (!symbol) throw new TradingError("bad_decision", "symbol is required");
  const market = markets.get(symbol);
  if (!market) throw new TradingError("unknown_symbol", `${symbol} is not in the snapshot`);
  return market;
}

function marksFor(state, markets) {
  const marks = new Map();
  for (const position of state.positions) {
    const market = markets.get(position.symbol);
    if (!market) {
      throw new TradingError("missing_mark", `no price for open position ${position.symbol}`);
    }
    marks.set(position.symbol, market.price);
  }
  return marks;
}
