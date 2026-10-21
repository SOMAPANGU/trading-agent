# Paper trading workflow

A five-minute paper account for stock-linked and crypto markets. Liquid Co-Invest Computer supplies quotes through MCP. Quiver notes are used when that MCP server is connected. Orders stay in a local ledger. The risk checks live in code.

This is a paper simulator, not a broker and not financial advice.

## Account

- Starting cash: **$100**
- Daily loss limit: **$5** from the UTC day's starting equity
- Risk per trade: **$1** of planned loss to the stop
- Leverage: **1**. Cash is reserved for the full notional
- A stop on the wrong side of the entry is rejected
- If the mark crosses the stop, the position is closed on that cycle
- A gap through the stop can lose more than $1. The daily limit then blocks new risk

`buy` opens a long, `sell` opens a short, `close` flattens one symbol, and `hold` leaves the book alone. Decision JSON cannot raise the limits or switch the ledger to live mode.

## Run one cycle

```bash
node src/cli.js \
  --snapshot snapshot.json \
  --decision decision.json \
  --tools tools.json
```

The state file is `/cursor/stores/self/paper-account.json` when that directory exists, otherwise `data/paper-account.json`. `TRADING_STATE_PATH` overrides it. The file is the account: the next run loads the same cash, positions, and journal.

`automation/PROMPT.md` is the instruction sheet for a scheduled run, including the snapshot and decision shapes.

## MCP

Co-Invest Computer is declared in `.cursor/mcp.json`:

`https://coinvest-computer.liquid.trade/mcp`

The server answers unauthorized calls with OAuth. Cloud agents and automations do not inherit that login from the repo file. Connect the server in the Cloud Agents MCP settings, or on the automation under Tools, and sign in at Liquid. Until a run's tool list includes a Liquid research tool, the engine records `mcp_unavailable` and does not open or close anything.

Quiver is optional. If its tools are present, put a short note in `snapshot.quiver` and set `usedQuiver` on the decision. If they are absent, omit the note and keep going.

Execution tools from either server are ignored. This package never calls them and contains no order client.

## Live mode

Live orders are refused. `--live` exits `4` and does not touch the ledger. Setting `LIQUID_LIVE_MODE` and `config/live-mode.flag` to `I_EXPLICITLY_ENABLE_LIVE_MODE` still does not send an order, because there is no live broker in this build. Turning live trading on later requires a reviewed change, not a prompt.

## Schedule

The cycle is meant to run every five minutes (`*/5 * * * *`). Each run follows `automation/PROMPT.md`: check the real MCP tool list, read markets, choose one action, then run the CLI. Routine cycles should not open a pull request.

## Tests

```bash
node --test
```
