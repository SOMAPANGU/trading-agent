# Paper trading cycle

Run this every five minutes. The ledger in code is the account. Liquid Co-Invest Computer is the market-data source. Quiver is optional context.

## Hard rules

- The account starts at $100 and stays a paper ledger. Do not send a live order.
- Do not pass `--live`. Do not set `LIQUID_LIVE_MODE`. Do not create `config/live-mode.flag`.
- Do not edit `src/constants.js` or any risk check. Limits are $5 of daily loss and $1 of planned loss per trade, enforced by `src/cycle.js`.
- Do not call a Co-Invest tool whose name places, cancels, or closes an order, even if it is listed. Research tools only.
- Do not invent prices, Quiver filings, or a tool catalog. If a tool is not in this run's tool list, it is unavailable.
- Do not open a pull request for a routine cycle, and do not commit the ledger.

## Each run

1. Read the tool list actually available to this run. Copy Liquid Co-Invest Computer tools into `tools.json` as `{ "server": "coinvest", "name": "<exact tool name>" }`. Copy Quiver tools the same way with `"server": "quiver"` when that server is connected. If Liquid research tools are missing, write `{ "tools": [] }` and still run the command below. That records `mcp_unavailable` and leaves positions unchanged.
2. If Liquid research tools are present, use them to load at least one stock-linked market and one crypto market. Write `snapshot.json`:

```json
{
  "markets": [
    { "symbol": "NVDA", "assetClass": "stock", "price": 100.0 },
    { "symbol": "BTC", "assetClass": "crypto", "price": 60000.0 }
  ],
  "quiver": [
    { "symbol": "NVDA", "summary": "short factual note from a Quiver tool" }
  ]
}
```

Omit `quiver` when those tools are not connected. Do not guess a summary.

3. Choose one action and write `decision.json`.
   - `buy` opens a long. `sell` opens a short. `close` flattens one symbol. `hold` does nothing.
   - A new position needs `notionalUsd` and `stopPrice`. The stop has to be on the protective side of the snapshot price. Planned loss is notional times the stop distance, and the engine rejects anything above $1. It also rejects leverage other than 1.
   - `close` does not take a notional. It exits the whole position.
   - Put the reason in your own words. Set `usedQuiver` to true only when a Quiver note for that symbol is in the snapshot.

```json
{
  "action": "hold",
  "reason": "why this action and not the others",
  "symbol": "NVDA",
  "notionalUsd": 20,
  "stopPrice": 95,
  "usedQuiver": false
}
```

`symbol`, `notionalUsd`, and `stopPrice` are required for `buy` and `sell`. `symbol` is required for `close`. `hold` only needs `action` and `reason`.

4. Run, from the repository root:

```bash
node src/cli.js \
  --snapshot snapshot.json \
  --decision decision.json \
  --tools tools.json
```

Do not pass `--state` or `--live`. The CLI writes `/cursor/stores/self/paper-account.json` when that store exists, otherwise `data/paper-account.json`. Deleting that file resets the account to $100.

5. Read the JSON result. Report the status, cash, open positions, whether Liquid research tools were present, and whether Quiver was used. If the engine rejects the order, leave the ledger as it is and do not retry with a larger size or a removed stop.
