import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { STARTING_CASH_CENTS } from "./constants.js";
import { TradingError } from "./errors.js";

export function utcDate(iso) {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new TradingError("bad_timestamp", "timestamp must be ISO-8601");
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

export function createAccount(nowIso) {
  const day = utcDate(nowIso);
  return {
    version: 1,
    mode: "paper",
    currency: "USD",
    startingCashCents: STARTING_CASH_CENTS,
    cashCents: STARTING_CASH_CENTS,
    day: { utcDate: day, startEquityCents: STARTING_CASH_CENTS },
    lastMarkedEquityCents: STARTING_CASH_CENTS,
    positions: [],
    decisions: [],
    trades: [],
    seq: 0,
    updatedAt: nowIso,
  };
}

export async function loadAccount(file, nowIso) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || parsed.mode !== "paper" || !Array.isArray(parsed.positions)) {
      throw new TradingError("corrupt_state", "account file is not a paper ledger");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return createAccount(nowIso);
    throw error;
  }
}

export async function saveAccount(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
