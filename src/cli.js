import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCycle } from "./cycle.js";
import { loadAccount, saveAccount } from "./ledger.js";
import { assessLiveRequest } from "./live-gate.js";

const LIVE_FLAG = path.resolve("config/live-mode.flag");

export function defaultStatePath() {
  if (process.env.TRADING_STATE_PATH) return path.resolve(process.env.TRADING_STATE_PATH);
  const store = "/cursor/stores/self";
  if (existsSync(store) && statSync(store).isDirectory()) {
    return path.join(store, "paper-account.json");
  }
  return path.resolve("data/paper-account.json");
}

function parseArgs(argv) {
  const out = { live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") {
      out.live = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function readJson(file, label) {
  if (!file) throw new Error(`missing --${label}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function readLiveFlag() {
  try {
    return readFileSync(LIVE_FLAG, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export async function runCli(argv, env = process.env) {
  const args = parseArgs(argv);
  const gate = assessLiveRequest({
    cliLive: args.live,
    envValue: env.LIQUID_LIVE_MODE || "",
    fileValue: readLiveFlag(),
  });
  if (gate.blocked || gate.sendLiveOrder) {
    return {
      exitCode: 4,
      gate,
      saved: false,
      output: {
        status: "refused",
        code: "live_disabled",
        detail: "Live orders are not enabled. No order was sent and the paper ledger was not changed.",
      },
    };
  }

  const statePath = args.state ? path.resolve(args.state) : defaultStatePath();
  const now = args.now || new Date().toISOString();
  const snapshot = readJson(args.snapshot, "snapshot");
  const decision = readJson(args.decision, "decision");
  const toolsDoc = readJson(args.tools, "tools");
  const tools = Array.isArray(toolsDoc) ? toolsDoc : toolsDoc.tools;
  const previous = await loadAccount(statePath, now);
  const { state, result } = runCycle(previous, {
    now,
    tools,
    markets: snapshot.markets,
    quiver: snapshot.quiver,
    decision,
  });
  await saveAccount(statePath, state);
  return { exitCode: 0, gate, saved: true, statePath, output: result, state };
}

async function main() {
  try {
    const outcome = await runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(outcome.output, null, 2)}\n`);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
