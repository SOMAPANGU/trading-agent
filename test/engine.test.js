import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCycle } from "../src/cycle.js";
import { LIMITS } from "../src/constants.js";
import { createAccount, loadAccount, saveAccount } from "../src/ledger.js";
import { assessLiveRequest } from "../src/live-gate.js";
import { isExecutionTool, preflight } from "../src/preflight.js";
import { plannedRiskCents } from "../src/risk.js";

const NOW = "2026-10-21T02:10:00.000Z";
const TOOLS = [{ server: "coinvest", name: "search_markets", description: "stock and crypto quotes" }];

function markets(stockPrice, extra = []) {
  return [
    { symbol: "NVDA", assetClass: "stock", price: stockPrice },
    { symbol: "BTC", assetClass: "crypto", price: 60_000 },
    ...extra,
  ];
}

function run(state, decision, { price = 100, now = NOW, tools = TOOLS, quiver, marketRows } = {}) {
  return runCycle(state, {
    now,
    tools,
    markets: marketRows || markets(price),
    quiver,
    decision,
  });
}

test("limits are the code constants, not decision fields", () => {
  assert.equal(LIMITS.startingCashCents, 10_000);
  assert.equal(LIMITS.dailyLossLimitCents, 500);
  assert.equal(LIMITS.riskPerTradeCents, 100);
  assert.equal(LIMITS.maxLeverage, 1);
  const account = createAccount(NOW);
  const { state, result } = run(account, {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 94.9,
    reason: "trying to override the cap",
    riskPerTradeUsd: 50,
    dailyLossLimitUsd: 100,
    mode: "live",
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "risk_per_trade");
  assert.equal(result.mode, "paper");
  assert.equal(state.cashCents, 10_000);
  assert.equal(state.positions.length, 0);
  assert.equal(result.limits.riskPerTradeCents, 100);
});

test("a one-dollar stop is filled and a wider stop is not resized", () => {
  const account = createAccount(NOW);
  assert.equal(
    plannedRiskCents({ side: "long", entryPrice: 100, stopPrice: 95, notionalCents: 2_000 }),
    100,
  );
  const opened = run(account, {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "stock dip with a one-dollar stop",
  });
  assert.equal(opened.result.status, "filled");
  assert.equal(opened.result.riskCents, 100);
  assert.equal(opened.state.cashCents, 8_000);
  assert.equal(opened.state.positions[0].side, "long");
  assert.equal(opened.state.mode, "paper");

  const blocked = run(opened.state, {
    action: "buy",
    symbol: "AAPL",
    notionalUsd: 20,
    stopPrice: 180,
    reason: "second stock, stop is too wide",
  }, {
    marketRows: [
      { symbol: "NVDA", assetClass: "stock", price: 100 },
      { symbol: "AAPL", assetClass: "stock", price: 200 },
      { symbol: "BTC", assetClass: "crypto", price: 60_000 },
    ],
  });
  assert.equal(blocked.result.status, "rejected");
  assert.equal(blocked.result.code, "risk_per_trade");
  assert.equal(blocked.state.positions.length, 1);
  assert.equal(blocked.state.cashCents, 8_000);
});

test("daily loss limit blocks new risk and still allows a close", () => {
  let state = createAccount(NOW);
  state.cashCents = 9_600;
  state.lastMarkedEquityCents = 9_600;
  const allowed = run(state, {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "room for one more dollar",
  });
  assert.equal(allowed.result.status, "filled");

  state = createAccount(NOW);
  state.cashCents = 9_599;
  state.lastMarkedEquityCents = 9_599;
  const blocked = run(state, {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "this would break the daily cap",
  });
  assert.equal(blocked.result.code, "daily_loss_limit");
  assert.equal(blocked.state.cashCents, 9_599);

  state = createAccount(NOW);
  state.cashCents = 9_500;
  state.positions = [];
  const halted = run(state, {
    action: "sell",
    symbol: "BTC",
    notionalUsd: 20,
    stopPrice: 63_000,
    reason: "daily halt should block a short too",
  });
  assert.equal(halted.result.code, "daily_loss_limit");

  const open = run(createAccount(NOW), {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "open then flatten",
  });
  open.state.day.startEquityCents = 10_500;
  const closed = run(open.state, {
    action: "close",
    symbol: "NVDA",
    reason: "flatten while the daily halt is on",
  }, { price: 96 });
  assert.equal(closed.result.status, "filled");
  assert.equal(closed.result.code, "closed");
  assert.equal(closed.state.positions.length, 0);
  assert.equal(closed.state.cashCents, 9_920);
});

test("stop loss fires from the snapshot and five one-dollar losses halt the sixth entry", () => {
  let state = createAccount(NOW);
  let price = 100;
  for (let i = 0; i < 5; i += 1) {
    const stop = price * 0.95;
    const opened = run(state, {
      action: "buy",
      symbol: "NVDA",
      notionalUsd: 20,
      stopPrice: stop,
      reason: `entry ${i + 1}`,
    }, { price });
    assert.equal(opened.result.status, "filled", opened.result.detail || opened.result.code);
    assert.equal(opened.result.riskCents, 100);
    price = stop;
    const stopped = run(opened.state, {
      action: "hold",
      reason: "wait for the stop",
    }, { price, now: `2026-10-21T02:${String(20 + i).padStart(2, "0")}:00.000Z` });
    assert.equal(stopped.result.status, "held");
    assert.ok(stopped.result.automaticStops.length === 1);
    assert.equal(stopped.result.automaticStops[0].pnlCents, -100);
    assert.equal(stopped.state.positions.length, 0);
    state = stopped.state;
  }
  assert.equal(state.cashCents, 9_500);
  const sixth = run(state, {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "daily cap is used up",
  });
  assert.equal(sixth.result.status, "rejected");
  assert.equal(sixth.result.code, "daily_loss_limit");
  assert.equal(sixth.state.cashCents, 9_500);
  assert.equal(sixth.state.trades.length, 10);
  assert.ok(sixth.state.decisions.length >= 11);
});

test("short, leverage, cash, scan, and quiver behavior", () => {
  const account = createAccount(NOW);
  const shorted = run(account, {
    action: "sell",
    symbol: "BTC",
    notionalUsd: 20,
    stopPrice: 63_000,
    reason: "crypto hedge",
    usedQuiver: true,
  }, {
    quiver: [{ symbol: "NVDA", summary: "Congress net buyers over the last month" }],
  });
  assert.equal(shorted.result.status, "filled");
  assert.equal(shorted.result.side, "short");
  assert.equal(shorted.result.quiverWarning, "quiver_not_available");
  assert.equal(shorted.result.quiverUsed, false);

  const withNote = run(createAccount(NOW), {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "insiders bought",
    usedQuiver: true,
  }, {
    quiver: [{ symbol: "NVDA", summary: "Recent Form 4 buys" }],
    tools: [
      ...TOOLS,
      { server: "quiver", name: "get_insider_trading" },
    ],
  });
  assert.equal(withNote.result.quiverUsed, true);
  assert.equal(withNote.result.quiver.summary, "Recent Form 4 buys");
  assert.equal(withNote.result.preflight.quiverAvailable, true);

  const leveraged = run(account, {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    leverage: 3,
    reason: "too much leverage",
  });
  assert.equal(leveraged.result.code, "leverage_disabled");

  const poor = run(account, {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 150,
    stopPrice: 99,
    reason: "bigger than cash",
  });
  assert.equal(poor.result.code, "insufficient_cash");

  const unscanned = run(account, {
    action: "buy",
    symbol: "BTC",
    notionalUsd: 20,
    stopPrice: 63_000,
    reason: "crypto only",
  }, { marketRows: [{ symbol: "BTC", assetClass: "crypto", price: 60_000 }] });
  assert.equal(unscanned.result.code, "incomplete_market_scan");

  const wrongStop = run(account, {
    action: "sell",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 90,
    reason: "stop on the wrong side",
  });
  assert.equal(wrongStop.result.code, "bad_stop");
});

test("missing MCP freezes the book and the next run keeps the position", () => {
  const opened = run(createAccount(NOW), {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "first fill",
  });
  const frozen = run(opened.state, {
    action: "sell",
    symbol: "BTC",
    notionalUsd: 20,
    stopPrice: 63_000,
    reason: "should not trade without the MCP catalog",
  }, { tools: [] });
  assert.equal(frozen.result.status, "rejected");
  assert.equal(frozen.result.code, "mcp_unavailable");
  assert.equal(frozen.state.positions.length, 1);
  assert.equal(frozen.state.cashCents, opened.state.cashCents);

  const held = run(frozen.state, {
    action: "hold",
    reason: "MCP catalog is empty",
  }, { tools: [], marketRows: [] });
  assert.equal(held.result.status, "held");
  assert.equal(held.result.code, "mcp_unavailable");
  assert.equal(held.state.positions.length, 1);

  const resumed = run(held.state, {
    action: "close",
    symbol: "NVDA",
    reason: "research tools are back",
  }, { price: 110 });
  assert.equal(resumed.result.status, "filled");
  assert.equal(resumed.state.positions.length, 0);
  assert.equal(resumed.state.cashCents, 10_200);
});

test("overnight gap counts against the new UTC day", () => {
  const opened = run(createAccount(NOW), {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "stop sits below the overnight mark",
  });
  assert.equal(opened.result.riskCents, 100);
  const next = run(opened.state, {
    action: "hold",
    reason: "mark the new day",
  }, { price: 97, now: "2026-10-22T00:05:00.000Z" });
  assert.equal(next.state.day.utcDate, "2026-10-22");
  assert.equal(next.state.day.startEquityCents, 10_000);
  assert.equal(next.state.lastMarkedEquityCents, 9_940);
  assert.equal(next.state.positions.length, 1);
});

test("ledger file survives a second load", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "paper-ledger-"));
  const file = path.join(dir, "paper-account.json");
  const opened = run(createAccount(NOW), {
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "persist me",
  });
  await saveAccount(file, opened.state);
  const loaded = await loadAccount(file, NOW);
  assert.equal(loaded.cashCents, 8_000);
  assert.equal(loaded.positions[0].symbol, "NVDA");
  const held = run(loaded, { action: "hold", reason: "still there" }, { price: 101 });
  await saveAccount(file, held.state);
  const again = JSON.parse(await readFile(file, "utf8"));
  assert.equal(again.positions.length, 1);
  assert.equal(again.decisions.length, 2);
  assert.equal(again.mode, "paper");
});

test("preflight separates research tools from execution tools", () => {
  assert.equal(isExecutionTool("place_order"), true);
  assert.equal(isExecutionTool("close_position"), true);
  assert.equal(isExecutionTool("get_recent_trades"), false);
  assert.equal(isExecutionTool("search_markets"), false);
  const report = preflight([
    { server: "coinvest", name: "search_markets" },
    { server: "coinvest", name: "place_order" },
    { server: "quiver", name: "get_congress_trades" },
  ]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.blockedExecutionTools, ["coinvest/place_order"]);
  assert.equal(report.quiverAvailable, true);
  assert.equal(preflight([{ server: "coinvest", name: "place_order" }]).ok, false);
  assert.equal(preflight([{ server: "other", name: "search_markets" }]).ok, false);
});

test("live switches never authorize an order", () => {
  const armed = assessLiveRequest({
    cliLive: true,
    envValue: "I_EXPLICITLY_ENABLE_LIVE_MODE",
    fileValue: "I_EXPLICITLY_ENABLE_LIVE_MODE",
  });
  assert.equal(armed.fullyArmed, true);
  assert.equal(armed.blocked, true);
  assert.equal(armed.sendLiveOrder, false);
  assert.equal(assessLiveRequest({ cliLive: false, envValue: "I_EXPLICITLY_ENABLE_LIVE_MODE" }).blocked, false);
});
