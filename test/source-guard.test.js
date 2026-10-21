import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

test("the trading package does not open a network connection or name an order RPC", () => {
  const files = readdirSync(srcDir).filter((file) => file.endsWith(".js"));
  assert.ok(files.length >= 5);
  const source = files.map((file) => readFileSync(path.join(srcDir, file), "utf8")).join("\n");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bplace_order\b/);
  assert.doesNotMatch(source, /coinvest-computer\.liquid\.trade/);
  assert.doesNotMatch(source, /child_process/);
  assert.match(source, /sendLiveOrder: false/);
});
