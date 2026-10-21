import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultStatePath, runCli } from "../src/cli.js";
import { LIVE_ENABLE_PHRASE } from "../src/constants.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/cli.js");

async function fixtureDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "paper-cli-"));
  const snapshot = path.join(dir, "snapshot.json");
  const decision = path.join(dir, "decision.json");
  const tools = path.join(dir, "tools.json");
  const state = path.join(dir, "paper-account.json");
  await writeFile(snapshot, JSON.stringify({
    markets: [
      { symbol: "NVDA", assetClass: "stock", price: 100 },
      { symbol: "BTC", assetClass: "crypto", price: 60000 },
    ],
  }));
  await writeFile(tools, JSON.stringify({
    tools: [{ server: "coinvest", name: "search_markets" }],
  }));
  return { dir, snapshot, decision, tools, state };
}

function spawnCli(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("two processes keep the same paper account and refuse a live flag", async () => {
  const { snapshot, decision, tools, state } = await fixtureDir();
  await writeFile(decision, JSON.stringify({
    action: "buy",
    symbol: "NVDA",
    notionalUsd: 20,
    stopPrice: 95,
    reason: "process one",
  }));
  const first = spawnCli([
    "--state", state,
    "--snapshot", snapshot,
    "--decision", decision,
    "--tools", tools,
    "--now", "2026-10-21T03:00:00.000Z",
  ]);
  assert.equal(first.status, 0, first.stderr);
  const firstOut = JSON.parse(first.stdout);
  assert.equal(firstOut.status, "filled");

  await writeFile(decision, JSON.stringify({
    action: "hold",
    reason: "process two sees the open position",
  }));
  const second = spawnCli([
    "--state", state,
    "--snapshot", snapshot,
    "--decision", decision,
    "--tools", tools,
    "--now", "2026-10-21T03:05:00.000Z",
  ]);
  assert.equal(second.status, 0, second.stderr);
  const saved = JSON.parse(await readFile(state, "utf8"));
  assert.equal(saved.cashCents, 8_000);
  assert.equal(saved.positions.length, 1);
  assert.equal(saved.decisions.length, 2);
  assert.equal(saved.decisions[1].code, "hold");

  const live = spawnCli(["--live", "--state", state]);
  assert.equal(live.status, 4);
  assert.equal(JSON.parse(live.stdout).code, "live_disabled");
  const afterLive = JSON.parse(await readFile(state, "utf8"));
  assert.equal(afterLive.cashCents, 8_000);
  assert.equal(afterLive.decisions.length, 2);

  const armedEnv = spawnCli([
    "--state", state,
    "--snapshot", snapshot,
    "--decision", decision,
    "--tools", tools,
    "--now", "2026-10-21T03:10:00.000Z",
  ], { LIQUID_LIVE_MODE: LIVE_ENABLE_PHRASE });
  assert.equal(armedEnv.status, 0, armedEnv.stderr);
  assert.equal(JSON.parse(armedEnv.stdout).mode, "paper");
});

test("runCli rejects an empty catalog without creating a live order", async () => {
  const { snapshot, decision, tools, state } = await fixtureDir();
  await writeFile(decision, JSON.stringify({ action: "hold", reason: "no tools yet" }));
  await writeFile(tools, JSON.stringify({ tools: [] }));
  const outcome = await runCli([
    "--state", state,
    "--snapshot", snapshot,
    "--decision", decision,
    "--tools", tools,
    "--now", "2026-10-21T04:00:00.000Z",
  ]);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.output.code, "mcp_unavailable");
  assert.equal(outcome.gate.sendLiveOrder, false);
  const saved = JSON.parse(await readFile(state, "utf8"));
  assert.equal(saved.startingCashCents, 10_000);
  assert.equal(saved.cashCents, 10_000);
});

test("default state path is the agent store when it exists", () => {
  const statePath = defaultStatePath();
  assert.equal(path.basename(statePath), "paper-account.json");
  assert.equal(statePath.startsWith("/cursor/stores/self"), true);
});
