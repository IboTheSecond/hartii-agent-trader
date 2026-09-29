# hartii-agent-trader

An open-source, standalone harness for running an autonomous **multi-agent AI trading
system** against [HartiiLabs](https://hartiilabs.com) — a memecoin launchpad on Quai Network
mainnet — through an on-chain **AgentVault** (a smart-contract wallet whose spending caps are
enforced on-chain, not by the bot).

This repo is **clean-room**: it talks only to the public `https://hartiilabs.com` HTTP API
(documented at [`/llms.txt`](https://hartiilabs.com/llms.txt) and
[`/api/agent/manifest`](https://hartiilabs.com/api/agent/manifest)) and to public, verified
contracts on [Quaiscan](https://quaiscan.io). It contains no code from, and does not import,
any private Hartii repository.

> **Status: scaffold.** Every module in `src/` currently exports typed stubs that throw
> `not implemented`. See [`INTERFACES.md`](./INTERFACES.md) for the full contract every module
> must implement, and the plan below for build order. Nothing in this repo can send a
> transaction yet — there is no code path that does, by design.

## What this is

Each trading cycle, several cheap, sandboxed, **read-only** AI analysts run in parallel
(Momentum Scout, Risk Analyst, Portfolio Manager), each returning a strict-JSON list of trade
proposals. A Decider agent (with narrow, guarded trade tools) reconciles those into 1-3
actions. Every action still passes through **code-enforced guards** (portfolio-fraction clip,
gas floor, price-impact ceiling, slippage floor, launch/NFT blocks, kill switch) before
anything reaches the chain — the model's judgment is never the trust boundary, the code is.

Two risk profiles ship: `reckless` (default — trade every cycle, size boldly on conviction,
fast rotation) and `balanced`. See `src/config` and `briefs/`.

## Safety model (read this before running live)

- **Paper mode by default.** `--paper` (or no real key configured) simulates fills against
  live quotes; nothing is signed or sent.
- **No secrets in the repo, ever.** All credentials come from environment variables — see
  [Environment variables](#environment-variables) below. `.env*`, `*.key`, `state/`, `logs/`,
  and `sandbox/` are gitignored.
- **On-chain caps are the real backstop.** `AgentVault.execute` only reaches allow-listed
  Hartii contracts, can never move ERC-20 tokens out of the vault, and enforces its own
  per-transaction and rolling-24h QUAI caps — independent of anything this code does.
- **Code-level guards run before every trade is built**, in `src/guard/` (pure functions, no
  I/O, fully unit-testable): a hard 40%-of-portfolio clip, a 5x-estimated-gas floor, a
  price-impact ceiling, a mandatory slippage floor, a launch-gate (off by default) and an
  **unconditional NFT-deploy block**.
- **A live trading loop only ever runs with a real key if you explicitly provide one.** Token
  launches are off unless you opt in; the agent never invents its own launch images.
- This is genuinely risky software if you point it at a funded vault with the `reckless`
  profile — that risk is the point (see the owner's brief in `briefs/knowledge.md`), but it is
  **your** risk to take with **your** funds. Nothing here is investment advice.

## Layout

```
src/config/   profiles (reckless, balanced), env loading/validation, constants
src/chain/    provider, address utils, minimal ABIs, vault execute calldata builders, gas, receipts, balances
src/data/     public HartiiLabs API client (market, token detail, trades, candles, holders, quotes, vault state)
src/tools/    MCP server(s): read-only intelligence tools + guarded trade tools, allowlist builder
src/guard/    pure guard math (portfolio clip, gas floor, impact, slippage, launch/NFT blocks)
src/ledger/   trade ledger, average-cost realised/unrealised PnL, deposits, gas accounting
src/agents/   multi-agent cognition: analyst + decider runners, prompts/briefs, JSON parsing, memory journal
src/runner/   cycle orchestration, loop, stop conditions, status.json, paper-mode switch
src/report/   Telegram + optional ntfy formatting/sending/throttling
src/sim/      paper-trading engine + replay/eval over public trade history
bin/          keygen.mjs, run.mjs, status.mjs
briefs/       knowledge + per-role prompts (markdown, public HartiiLabs mechanics only)
test/         node:test suites, one file per src/ module
```

See [`INTERFACES.md`](./INTERFACES.md) for exact exports, JSON contracts, MCP tool schemas,
the ledger schema, and every environment variable.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `HARTII_AGENT_KEY` or `HARTII_AGENT_KEY_FILE` | for live mode only | agent EOA private key (raw or path to a key file) — never required in paper mode |
| `HARTII_VAULT_ADDRESS` | yes (live) | the AgentVault this bot trades through |
| `TELEGRAM_BOT_TOKEN` | for reporting | Telegram bot token |
| `TELEGRAM_CHAT_ID` | for reporting | Telegram chat/channel to report to |
| `NTFY_URL` | optional | extra push notification target |
| `HARTII_API_BASE` | no | default `https://hartiilabs.com` |
| `HARTII_RPC_URL` | no | default `https://rpc.quai.network/cyprus1` |
| `HARTII_PROFILE` | no | `reckless` (default) or `balanced` |
| `HARTII_PAPER` | no | `1` forces paper mode regardless of keys |

Full list, defaults, and validation rules: [`INTERFACES.md`](./INTERFACES.md#env).

## Running

```sh
npm install
npm test                       # node:test, no network, fetch injected in every test

node bin/run.mjs --paper --once   # one paper cycle, prints the cycle result
node bin/status.mjs               # print last known status.json
npm start                         # node bin/run.mjs --loop (paper unless real keys + --live are set)
```

Every command above is currently a scaffold stub (see Status note up top) until the modules in
`src/` are implemented against `INTERFACES.md`.

## Build plan (for parallel implementers)

The module boundaries in `INTERFACES.md` are frozen so multiple people/agents can build
against them without touching each other's folders:

1. `src/config` + `src/chain` + `src/data` — no dependencies on the rest, unblocks everyone else.
2. `src/guard` + `src/ledger` — pure logic, depend only on `src/config` types.
3. `src/tools` + `src/report` — depend on `src/data`, `src/chain`, `src/guard`.
4. `src/agents` + `src/sim` — depend on `src/tools`, `src/data`.
5. `src/runner` + `bin/` wires everything together last.

## License

MIT — see [`LICENSE`](./LICENSE).
