# INTERFACE-REQUESTS.md

A shared log for anything an implementer needed from another module's owner that INTERFACES.md
doesn't already pin. Append a dated, attributed entry rather than editing someone else's — this
file is written by multiple parallel implementers.

---

## From: `src/agents` (2026-09-29)

### 1. `bin/mcp-server.mjs` does not exist yet — src/agents assumes a shape for it

`runAnalyst`/`runDecider` (src/agents) spawn a sandboxed `claude -p` process whose
`--mcp-config` must point at a command that starts the actual MCP server subprocess (stdio
transport) `claude` itself launches. INTERFACES.md's `src/agents` section doesn't pin what that
command is — only `src/tools#createMcpServer`/`buildReadOnlyTools`/`buildTradeTools` (now
implemented) build the tool list itself.

**What src/agents assumes, and what it needs from whoever wires `bin/`:**

- Default command: `node <repoRoot>/bin/mcp-server.mjs --role <role>` (role ∈ `momentumScout` |
  `riskAnalyst` | `portfolioManager` | `decider`), see `DEFAULT_MCP_SERVER_ENTRY` in
  `src/agents/index.mjs`. Every caller (eventually `src/runner`) can override this via
  `opts.mcpServerCommand` / `opts.mcpServerArgs` / `opts.mcpServerEnv` on `runAnalyst`/
  `runDecider`, so the default only matters once `bin/mcp-server.mjs` actually exists.
- **MCP server name must be `"hartii-agent"`** — `src/agents` builds `--allowedTools` ids as
  `mcp__hartii-agent__<tool>`, so whatever calls `src/tools#createMcpServer(tools, { name })`
  from inside `bin/mcp-server.mjs` must pass `name: 'hartii-agent'` (matches
  `MCP_SERVER_NAME` exported from `src/agents/index.mjs`) or every sandboxed session's
  `--allowedTools` will silently allow nothing.
- Expected behavior of `bin/mcp-server.mjs --role <role>`: read `--role` (or an env var — either
  is fine, src/agents doesn't care which since it fully controls both argv and env via the opts
  above), pick the matching tool subset (`buildReadOnlyTools` for the three analyst roles,
  `buildReadOnlyTools + buildTradeTools` for `decider`, filtered to that role's
  `TOOL_ALLOWLISTS[role]` entry so a stray extra tool can't leak past even a bug elsewhere), then
  `createMcpServer(tools, { name: 'hartii-agent' })` + `serveStdio(server)` (both already
  exported by `src/tools`).
- This module never reaches this code path in its own tests — `spawnImpl` is always faked, so
  nothing here is blocking; it's only relevant once `src/runner`/`bin/` wire a real end-to-end
  run.

No response needed unless the chosen server name or entry path differs from the above — if so,
`src/agents`' defaults (`MCP_SERVER_NAME`, `DEFAULT_MCP_SERVER_ENTRY`) will need a matching PR.

**[reply from `src/tools`, 2026-09-29]:** confirmed compatible, no code change needed.
`createMcpServer(tools, opts)` takes `opts.name` verbatim (no hardcoded name) — pass
`{ name: 'hartii-agent' }` from `bin/mcp-server.mjs` and it matches `MCP_SERVER_NAME` exactly.
`serveStdio(server)` is exported from `src/tools/index.mjs` (connects an already-built
`McpServer` to a `StdioServerTransport`) even though it isn't in the pinned INTERFACES.md
surface — see the `src/tools` entry below for the exact filter-by-`TOOL_ALLOWLISTS[role]`
pattern `bin/mcp-server.mjs` should use.

### 2. Minor: `AnalystProposal.token`/`AnalystProposal` schema is now enforced strictly

`src/agents#parseAnalystOutput`/`parseDeciderOutput` (zod) reject a proposal whose `token` isn't
a well-formed `0x` + 40 hex-char address, an `action`/`confidence`/`side` outside the enums in
INTERFACES.md, a `txHash` that isn't a well-formed 32-byte hash (or `null`), or a decider result
with more than 3 actions. This is by design (never trust/forward a hallucinated shape), noted
here only so `src/runner`'s owner knows a malformed decider/analyst reply becomes a thrown
`AgentOutputError`, not a partially-valid object — `runAnalystsInParallel` already downgrades a
per-analyst throw to `[]` for that role; `runDecider`'s throw is not caught internally (a decider
that can't produce a valid result should be treated as "took no verifiable action" by the
caller, never papered over with a fabricated no-op result).

---

## From: `src/data` + `src/tools` (2026-09-29)

### 1. `ToolCtx` needs a `ledger` (or `ledgerApi`) field

INTERFACES.md's `hartii_status` MCP tool says its output is "`VaultState` plus
`{ realizedPnlWei, unrealizedPnlWei, growthPct }` **from `src/ledger`**", but the pinned
`ToolCtx` shape (`{ api, provider, wallet, vault, config, guardCtx }`) has nowhere to carry a
ledger reference.

**What `src/tools` did in the meantime:** `buildReadOnlyTools` reads two *optional*,
duck-typed fields off `ctx` that are not yet in the pinned `ToolCtx` type:

- `ctx.ledger` — a `Ledger` object (the `src/ledger` schema).
- `ctx.ledgerApi` — an object exposing `getRealizedPnlWei(ledger)`, `getUnrealizedPnlWei(ledger,
  markPricesWeiByToken)`, `getGrowthPct(ledger, currentPortfolioQuaiWei)` (i.e. `src/ledger`'s
  own exports, passed in rather than imported directly, so `src/tools` never hard-depends on
  `src/ledger`'s build status).

When either is missing, `hartii_status` returns `realizedPnlWei: '0'`, `unrealizedPnlWei: '0'`,
`growthPct: 0` instead of throwing — so the tool is usable today and upgrades silently once the
runner wires a real ledger through.

**Ask:** whoever wires `bin/run.mjs` / `src/runner` should add `ledger: Ledger` and
`ledgerApi: typeof import('../ledger/index.mjs')` to the `ToolCtx` type in INTERFACES.md and
pass both through when constructing the tool context. `markPricesWeiByToken` is derived inside
`src/tools` from each holding's `markValueQuaiWei / amountWei` (18-decimal fixed point) — no
change needed there.

### 2. `ToolCtx` needs a `paperEngine` field for guarded trade tools

INTERFACES.md's `src/runner#runCycle` note says "paperMode routes trade-tool handlers to
`src/sim` instead of `src/chain#sendVaultExecute`", but nothing in `src/runner` or `ToolCtx`
says how the trade-tool handler *gets* the paper engine.

**What `src/tools` did:** `buildTradeTools`'s `hartii_buy`/`hartii_sell` handlers check
`ctx.config.paperMode`; when true they call `ctx.paperEngine.buy(...)` /
`ctx.paperEngine.sell(...)` (the `PaperEngine` instance from `src/sim#createPaperEngine`) and
never touch `src/chain#sendVaultExecute`. If `paperMode` is true and `ctx.paperEngine` is
missing, the tool returns `{ ok: false, error: 'paper mode requires ctx.paperEngine to be
wired' }` rather than silently doing nothing or accidentally reaching live code — fail loud,
never fail open.

**Ask:** add `paperEngine: PaperEngine | null` to `ToolCtx` in INTERFACES.md. The
runner should construct one `PaperEngine` per run (so simulated positions persist across
cycles) and pass it through unchanged when `config.paperMode` is true, `null` otherwise.

### 3. `ToolCtx` gains optional `chain` / `guard` DI overrides

`src/chain` and `src/guard` were still stubs (`not implemented`) while `src/tools` was built in
parallel per the task brief. To keep `src/tools`'s own test suite hermetic (no dependency on
another module's build status, per the "no network in unit tests" / injectable-dependency
cross-cutting rule) without changing production behavior, `buildTradeTools(ctx)` resolves its
chain/guard bindings as:

```js
const chain = ctx.chain || defaultChain; // real '../chain/index.mjs' import
const guard = ctx.guard || defaultGuard; // real '../guard/index.mjs' import
```

Production callers (nothing outside `src/tools`'s own tests today) omit `ctx.chain`/`ctx.guard`
and get the real modules — this is purely additive and does not change the documented
`buildTradeTools(ctx: ToolCtx) -> ToolDef[]` signature or behavior now that `src/chain`/
`src/guard` have landed.

**Ask:** add `chain?: typeof import('../chain/index.mjs')` and `guard?: typeof
import('../guard/index.mjs')` to `ToolCtx` in INTERFACES.md as optional/test-only fields, or
confirm this is fine left undocumented as an internal seam. No action needed if the latter.

### 4. Extended the read-only tool set beyond the 3 pinned schemas

INTERFACES.md's "MCP tool schemas" section only fully specifies `hartii_market`,
`hartii_status`, `hartii_quote`, `hartii_buy`, `hartii_sell`, `hartii_launch_token` — but the
**already-committed** `TOOL_ALLOWLISTS` stub referenced `hartii_token_detail` (for
`riskAnalyst`) with no schema defined anywhere, and the task brief's own tool list names
`market_scan, token_deep_dive, trade_flow, holders, quote, portfolio` (i.e. it expects
deep-dive/trade-flow/holders tools beyond the minimum pinned set).

**What `src/tools` did:** implemented all three as additive, non-breaking read-only tools and
extended the analyst allowlists to actually reach them (kept the original 4 pinned tools'
behavior unchanged):

- `hartii_token_detail` (`{ token }`) — sanitized token detail + combined liquidity +
  holder concentration (top10 + creator share) + curve progress toward graduation.
- `hartii_trade_flow` (`{ token, limit? }`) — recent trades + buy/sell QUAI-volume imbalance +
  unique-trader count. Momentum Scout's brief says it "ranks movers from market + trade flow",
  so it was added to `TOOL_ALLOWLISTS.momentumScout` too (was `['hartii_market']`, now
  `['hartii_market', 'hartii_trade_flow']`).
- `hartii_holders` (`{ token, limit? }`) — holder list + top-10 concentration.
- `TOOL_ALLOWLISTS.riskAnalyst` extended from `['hartii_market', 'hartii_token_detail']` to
  `['hartii_market', 'hartii_token_detail', 'hartii_holders', 'hartii_trade_flow']` — the risk
  brief (holder concentration, one-wallet volume, thin liquidity) needs both.
- Added `export function resolveAllowlist(role, config)` — returns the right list per role,
  appending `'hartii_launch_token'` to `decider`'s list only when `config.launchesEnabled` is
  true. **`bin/mcp-server.mjs` should call `resolveAllowlist(role, config)` and filter its tool
  array to that list** (see reply on the `src/agents` entry above) rather than reading
  `TOOL_ALLOWLISTS[role]` directly, so the launch-tool append isn't duplicated at the call site.

**Ask:** fold these into INTERFACES.md's `src/tools` section (tool schemas + the updated
`TOOL_ALLOWLISTS` + `resolveAllowlist`).

### 5. `src/chain` has no calldata builder for token launches

`hartii_launch_token` (present only when `launchesEnabled`) runs
`src/guard#enforceLaunchGate` correctly, but even when the gate passes there is no
`buildLaunchCalldata`-shaped export anywhere in `src/chain`'s pinned interface to actually
build a sendable transaction. `src/tools` returns `{ ok: false, error: 'token-launch calldata
building is not yet implemented in src/chain — see INTERFACE-REQUESTS.md' }` in that case —
correctly gated, never a fabricated tx, but also not a working feature.

**Ask:** if launches are meant to actually work in v1, `src/chain` needs a launch-calldata
builder (verified against the real TokenFactory ABI on Quaiscan, per INTERFACES.md's existing
ABI-verification rule) and `src/tools#buildLaunchTool` needs a follow-up patch to call it. Low
priority — launches are off by default and this does not block paper-mode trading.

### 6. [note, no action needed] `sanitizeTokenText` allow-lists instead of blocking

INTERFACES.md describes `sanitizeTokenText` as dropping/truncating "description/socials"
specifically. The shipped implementation is stricter: it allow-lists scalar fields (drops any
nested object/array outright, plus a fixed set of known free-text/link key names) rather than
blocking a fixed list of bad keys — so an unexpected new field from the API can never leak
unsanitized structured content into a prompt. Every field in the pinned `TokenListItem` shape
survives sanitization unchanged (besides `name`/`symbol` truncation); this only affects fields
*not* in that documented shape.

### 7. [note, no action needed] `hartii_market` tradeability filter is a best-effort heuristic

INTERFACES.md's `TokenListItem` type has a `status: string` field but doesn't enumerate its
values, and the `hartii_market` schema says candidates are "`tradeable: true` only —
hidden/flagged/untradeable already excluded" without pinning the exact field names that signal
that. `isTradeable()` in `src/tools` currently excludes rows where `tradeable === false`,
`hidden === true`, `flagged === true`, or `status` (case-insensitive) is one of `hidden,
flagged, delisted, banned, rugged, paused, blocked`. If the real API uses different field
names/values for this, update `isTradeable()` in `src/tools/index.mjs` — it's a single small
function, no other module depends on its internals.

---

## From: `src/runner` + `src/report` + `src/sim` + `bin/` (2026-09-29)

### 1. Created `bin/mcp-server.mjs` — confirming the shape `src/agents`/`src/tools` assumed

Per the `src/agents` entry above and its `src/tools` reply, `bin/mcp-server.mjs` now exists:
`node bin/mcp-server.mjs --role <role>` builds a `ToolCtx` (api/provider/wallet/vault/config +
the `ledger`/`ledgerApi`/`paperEngine` fields `src/tools` documented needing), filters
`buildReadOnlyTools`/`buildTradeTools`'s output to `resolveAllowlist(role, config)` (belt-and-
braces, even though those builders already return a role-appropriate-ish set), and serves it
over stdio via `createMcpServer(tools, { name: 'hartii-agent' })` + `serveStdio`. No response
needed unless something about this doesn't match what a real spawn needs — nothing outside this
file's own tests has exercised it end-to-end yet (blocked on `src/config#loadConfig` still being
a stub as of this writing — see item 5 below).

### 2. `src/agents`' spawn options default `mcpServerEnv` to `{}`, not "inherit" — `src/runner` now passes `process.env` explicitly

`spawnSandboxedSession`'s `opts.mcpServerEnv = {}` default means a spawned `bin/mcp-server.mjs`
subprocess would see none of `HARTII_VAULT_ADDRESS`/`HARTII_AGENT_KEY_FILE`/`TELEGRAM_*`/etc.
unless something passes them through explicitly. `src/runner#runCycle` now calls
`runAnalystsInParallel(input, { mcpServerEnv: process.env })` and
`runDecider(input, { mcpServerEnv: process.env })` — every env var this process has, forwarded
as-is. If `claude -p`'s own mcp-config `env` handling merges with the parent's environment
rather than replacing it, this is redundant but harmless; if it replaces, it's required. No
action needed unless this assumption is wrong.

### 3. Paper mode never reads a real vault for portfolio/holdings/capital-exhausted — the ledger is authoritative instead

`src/tools`' own `executeGuardedTrade`/`hartii_status` still call `ctx.api.getVault(ctx.vault)`
even in paper mode (for portfolio-fraction guard sizing and status reporting) — see that
module's entries above. `src/runner` deliberately does **not** mirror that for its own
`AnalystInput`/`DeciderInput`/`status.json` construction: a real vault's live balance is not
"the paper portfolio" (nothing paper touches it), so `runCycle`/`shouldStop` derive
`portfolio`/`holdings` from `ctx.ledger` in paper mode instead
(`src/sim#derivePaperPortfolioFromLedger`, new export — cash = deposits − buys + sells − gas;
positions straight from `ledger.positions`). Holding mark values are estimated from each
token's `lastPriceWei` already present in the same `getTokens()` call `market` comes from —
deliberately not an extra live quote per holding.

**Known residual gap (documented, not fixed here — not this module's file to fix):** because
`src/tools`' `hartii_status`/`hartii_buy`/`hartii_sell` still read the real vault even in paper
mode, a sandboxed session's own direct tool calls can disagree with the ledger-accurate context
`src/runner` embeds in its prompt (`AnalystInput.portfolio`/`holdings`) — most visibly, a *pure*
paper session with no `HARTII_VAULT_ADDRESS` configured at all will see `hartii_status` return
`{ ok: false, error: 'ctx.vault is not configured' }`, and `hartii_buy`/`hartii_sell` will call
`ctx.api.getVault(undefined)` for their own internal `fullPortfolioQuaiWei` guard-sizing (which
will fail against a real API). **Recommend paper rehearsals configure a real (even unfunded)
`HARTII_VAULT_ADDRESS`** until `src/tools` reconciles its own paper-mode awareness for those
three tools — flagging this rather than changing `src/tools` myself, since it isn't this
module's file. README's Running section now says so.

### 4. `src/sim#createPaperEngine` gained an additive optional `initialPositions` field

Needed so `bin/mcp-server.mjs` can seed a freshly-constructed `PaperEngine` (a brand new one
every subprocess spawn — stdio MCP servers don't persist across process boundaries) with
whatever a session already holds per the ledger, so a decider can `hartii_sell` an existing
paper position instead of every fresh subprocess starting "empty" regardless of ledger state.
Purely additive to the pinned `createPaperEngine({initialQuaiWei, api})` signature — existing
callers are unaffected. No action needed from any other module; noted here for visibility since
`src/sim` is this same entry's author.

### 5. Status check: `src/config#loadConfig`/`#getAgentKeyMaterial` are the last blocking stub as of 2026-09-29 (this writing)

Every other `src/*` module (`chain`, `data`, `guard`, `ledger`, `tools`, `agents`) had no
remaining `not implemented` call sites at the time this was written. `bin/run.mjs --once --paper`
run for real fails at `src/config: loadConfig not implemented` — the only reason the harness
can't be smoke-tested fully end-to-end right now. No action needed beyond finishing that module;
noted here only so the status is stated plainly rather than implied.

---

## From: integration (2026-09-29)

Implemented `src/config` (`loadConfig`/`getAgentKeyMaterial`) — the last blocking stub — and
resolved every open item above:

1. **`src/config` implemented.** `loadConfig` validates the full `env` table (mutually-exclusive
   key/key-file, live-mode-only `HARTII_VAULT_ADDRESS` requirement, profile/numeric/telegram
   validation, `HARTII_STATE_DIR`-derived paths), collects every missing/invalid field into one
   `ConfigError` rather than throwing on the first, and never exposes the resolved key material as
   an enumerable/JSON-serializable field (stored behind a module-private `Symbol`, non-enumerable,
   on the frozen `Config`). 22 new tests in `test/config.test.mjs` (real temp-file key reads, no
   network). `getAgentKeyMaterial` throws when `config.paperMode` is true, as pinned.
2. **`ToolCtx.ledger`/`ledgerApi`/`paperEngine`/`chain`/`guard` folded into INTERFACES.md's
   `src/tools` section** (were previously duck-typed-only) — `bin/mcp-server.mjs` already wired
   all of them per its own header comment; this just makes the pinned contract match reality.
3. **Extended tool set + `resolveAllowlist` folded into INTERFACES.md** (`hartii_token_detail`,
   `hartii_trade_flow`, `hartii_holders`, the updated `TOOL_ALLOWLISTS`, `serveStdio`).
4. **Resolved (code, not just documented): "paper mode never reads a real vault" now also covers
   `src/tools`' own `hartii_status`/`hartii_buy`/`hartii_sell`**, not just `src/runner`'s prompt
   context. When `config.paperMode` is true and `ctx.vault` is unset, these three tools now derive
   portfolio-sizing state from `ctx.paperEngine.getState()` (holding marks from a best-effort live
   sell quote per position) instead of requiring a live vault read, and use a documented
   approximate gas-estimate fallback (`src/tools#DEFAULT_PAPER_GAS_ESTIMATE_WEI`, 4 QUAI, per
   HARTII CHAIN FACTS) instead of a real `chain.estimateGasWei` preview, since there's no deployed
   `vault.execute()` target to preview against with no vault configured. `ctx.paperEngine` is
   still required either way (clean `ok:false`, never a throw). A configured vault (even unfunded,
   in paper mode) still takes the real-read path unchanged — this is purely additive for the
   no-vault-at-all case. README's "configure a real vault even for paper rehearsals" caveat is now
   a recommendation for extra realism, not a requirement to get a paper session running at all. 8
   new tests in `test/tools.test.mjs` cover both the new no-vault paper path and confirm every
   pre-existing vault-configured test's behavior is byte-for-byte unchanged.
5. **`bin/run.mjs` now seeds a one-time simulated starting paper balance** the first time a fresh
   ledger is used in paper mode (`seedPaperLedgerIfFresh`, called from `main()` only — never from
   the unit-tested `buildRunnerCtx`, so `npm test` never writes to `state/ledger.json`) —
   `src/sim#DEFAULT_PAPER_STARTING_QUAI_WEI` existed already but nothing ever wired it to an actual
   `src/ledger#recordDeposit`, so a brand-new paper session could never afford its first buy (paper
   cash is `totalDepositedWei − buys + sells − gas`; a fresh ledger has `totalDepositedWei: '0'`).
   Persisted to disk before any cycle runs, so every `bin/mcp-server.mjs` subprocess reads the same
   seeded ledger. Live mode and any ledger with a prior deposit (real or seeded) are untouched.
6. **Item 5 (V3/launch calldata builder)** left open as originally flagged — low priority, launches
   off by default, not required for paper-mode trading.
7. **Real smoke test (`node bin/run.mjs --paper --once` against the live API + RPC) surfaced that
   `src/data`'s "confirmed live 2026-09-29" claim for `/api/tokens`/`/api/token/:addr`/
   `/api/token/:addr/trades`/`/api/token/:addr/holders`/`/api/token/:addr/candles`/
   `/api/agent/quote` was wrong** — re-verified live just now (2026-09-29, this session) against
   the real responses:
   - **List endpoints wrap their array**: `/api/tokens` → `{network,view,items:[...]}`,
     `/api/token/:addr/{trades,holders,candles}` → `{address,items:[...]}`, not a bare array.
     `getTokens()` returned the whole envelope object, so `(tokens || []).filter is not a
     function` crashed `src/runner#runCycle` on its very first real call — this was the first
     thing the smoke test hit, and would have blocked literally every cycle.
   - **`/api/token/:addr` wraps its payload**: `{ token: {...} }`, not the token object itself.
   - **Trade rows use `trader`/`quaiAmount`/`tokenAmount`/`blockTime`**, not `wallet`/
     `amountQuaiWei`/`amountTokenWei`/`at`. `/api/trades/recent` rows carry no `tokenAmount` at
     all (a lighter-weight shape than the per-token trades endpoint).
   - **Holder rows use `holder`/`balance`**, not `wallet`/`amountWei`, and carry **no percentage
     field at all** (`pct` doesn't exist in the response — the previous pinned type's `pct:
     number` was never actually confirmable against a real response).
   - **Candle rows use `bucketStart` (whole seconds)/`open`/`high`/`low`/`close`/`volumeQuai`**,
     not `t` (ms)/`o`/`h`/`l`/`c`/`volumeWei`.
   - **`/api/agent/quote` returns `{token,side,amountInWei,feeWei,expectedOutWei,graduated,isV3,at}`
     — there is no `amountOut`, `priceImpact`, or `minOut` field at all.** This is the most
     severe of these: `src/sim#createPaperEngine.buy/sell` reads `quote.amountOut` via a
     `toBigInt` call that *throws* on `undefined`, so **every single paper buy/sell would have
     failed** with "bad quote: ..." before this fix — the harness's core promise ("guarded paper
     execution") was non-functional end to end. Separately, `src/tools#executeGuardedTrade` read
     `quote.priceImpact ?? 0` — since the field never exists, this silently defaulted the
     mandatory price-impact guard to "0% impact, always passes" on every real trade, silently
     disabling a HARD SAFETY RULE (price impact ≤ configured ceiling) rather than merely being
     inaccurate.

   **Fixed in `src/data`** (normalizes at the boundary, once, so nothing downstream needs to know
   the raw wire format — see INTERFACES.md's rewritten "Raw wire format" section):
   `getTokens`/`getCandles`/`getTrades`/`getHolders`/`getRecentTrades` now unwrap `items` (still
   accepting a bare array defensively); `getToken` unwraps `.token`; every row is mapped to this
   module's own pinned field names; `getQuote` maps `expectedOutWei→amountOut`,
   `amountInWei→amountIn`, and passes `feeWei`/`graduated`/`isV3` through additively, with
   `priceImpact: null` (never fabricated) since the endpoint has no such field.

   **Fixed in `src/tools`**: `computePriceImpactPct` (new) derives price impact from the quote's
   own implied average execution price vs. the token's current spot price
   (`ctx.api.getToken(token).lastPriceWei`) whenever `quote.priceImpact` isn't already a number —
   and returns `NaN` (never `0`) on any failure to compute it, so
   `src/guard#enforcePriceImpact`'s existing "reject a non-finite priceImpactPct" rule makes an
   unknown price impact **fail closed**, exactly like an excessive one, rather than ever silently
   passing as "negligible." `holderPct` (new) computes a holder's percentage from
   `amountWei/totalSupplyWei` whenever the row itself doesn't already carry a `pct` (the live API
   never does) — `hartii_holders` now also fetches the token's `totalSupplyWei` (best-effort, one
   extra cached call) so its own top10Pct is a real number instead of always 0.

   16 new tests across `test/data.test.mjs` (real envelope/field-name fixtures for every
   endpoint) and `test/tools.test.mjs` (priceImpact fallback + fail-closed-on-failure +
   "trusts an explicit quote.priceImpact and skips the extra call" paths). Every pre-existing
   test's fixtures happened to already match the post-normalization shape for the specific
   fields each one asserted on, so none needed changing — confirmed by running them unmodified
   before adding the new ones.

   **Not re-verified this pass** (flagged, not fixed): `/api/agent/vault/:addr`'s `VaultState`
   shape and `/api/agent/manifest`'s exact `caps`/`targets`/`forbiddenSelectors` fields — this
   smoke test ran with no `HARTII_VAULT_ADDRESS` configured (paper mode, no vault — see item 4
   above), so neither was exercised against the real endpoint. Re-verify against a real vault
   address before trusting `VaultState` in live mode.

8. **Real smoke test also surfaced `spawn ENAMETOOLONG` on the decider** (Windows' ~32K total
   command-line length, easily exceeded once the task prompt embeds a real market snapshot plus
   all three analysts' proposals) — `src/agents` was passing the task prompt as a positional argv
   element to `claude -p <task>`. **Fixed**: the task now travels over the spawned child's stdin
   (`-p` with no attached value is Claude Code's documented "read the prompt from stdin" form);
   `buildClaudeArgv` no longer takes/embeds `task` at all, `runChildWithTimeout` writes+closes
   `opts.stdin`. `systemPrompt` (`--append-system-prompt`) stays on argv — it's bounded by
   `briefs/*.md`'s own size (a few KB), nowhere near the limit. New regression test asserts the
   task text never appears in argv and does appear on the captured child's stdin.
9. **Real smoke test also surfaced that every relative state path
   (`ledgerFile`/`statusFile`/`memoryFile`/`killSwitchFile`, default `state/...`) was resolved
   against `process.cwd()`** — fine for `bin/run.mjs`'s own process, but `src/agents` spawns each
   sandboxed analyst/decider session with its cwd set to a fresh, empty, per-invocation temp
   sandbox directory (see `src/agents#createSandbox`), and `bin/mcp-server.mjs` (the MCP server
   subprocess running inside that sandbox) calls `loadConfig(env)` again from there. A relative
   `ledgerFile` therefore resolved to two different, unrelated locations depending which process
   asked — confirmed live: `bin/run.mjs` correctly seeded `state/ledger.json` with 1000 QUAI paper
   capital (visible in `status.json`), but the decider's own `hartii_status` tool call, running
   inside the sandbox, read an empty ledger at its own sandbox-relative `state/ledger.json` (which
   doesn't exist) and reported "Vault QUAI balance is 0", refusing to trade despite real, fundable
   candidates. **Fixed in `src/config`**: every state path is now resolved to an **absolute** path
   anchored at this repo's own root (derived from `src/config/index.mjs`'s own file location via
   `import.meta.url`, never `process.cwd()`) — so `loadConfig(env)` resolves to the exact same
   ledger/status/memory/kill-switch files no matter which process or working directory calls it.
   An already-absolute `HARTII_STATE_DIR`/`HARTII_KILL_SWITCH_FILE` is used as-is (e.g. for a
   deliberately test-isolated location). New tests cover both the repo-root-anchored default and
   the already-absolute case.
10. Full suite green (`npm test`). `node bin/run.mjs --paper --once` run for real against the live
    public API + RPC (no key, no transaction) — see git log / session notes for the outcome.

---

## From: security fix pass (2026-09-30)

A pre-publish security review found 4 issues (1 critical, 2 high, 1 medium). All 4 applied:

1. **[critical] Full `process.env` (incl. TELEGRAM_BOT_TOKEN and, if set, the raw
   HARTII_AGENT_KEY) was being written to a plaintext `mcp-config.json` in the OS temp dir for
   EVERY sandboxed spawn — including the three READ-ONLY analyst roles, every single cycle.**
   `src/runner#runCycle` called `runAnalystsInParallel(input, { mcpServerEnv: process.env })` /
   `runDecider(input, { mcpServerEnv: process.env })`; `src/agents`' own `childEnv` default was
   also `process.env` (the top-level `claude` process's own env, not just the MCP subprocess's).
   **Fixed:** `src/runner#buildMcpServerEnv(env, role, paperMode)` — a new export — builds a
   role-scoped ALLOWLIST (non-secret operational `HARTII_*` vars only); the agent signing key is
   forwarded only for `role === 'decider'` in live mode, never to a read-only analyst, never in
   paper mode. `src/agents#buildChildEnv` — also new — does the same for the top-level `claude`
   process (OS essentials + `ANTHROPIC_*`/`CLAUDE_*` only). `mcp-config.json` is now written mode
   `0600`. The test that previously asserted `mcpServerEnv === process.env` (documenting the bug)
   was rewritten to assert the new allowlisted behavior instead.
2. **[high] `enforceSlippageFloor` only checked minOut was set/positive — never against the live
   quote it was sized from, so a decider could clear it with e.g. `minOut: "1"`, disabling real
   slippage protection.** **Fixed:** `enforceSlippageFloor(minOutWei, { quotedAmountOutWei,
   maxSlippageBps })` (backward compatible — the second arg is optional) now ALSO rejects a
   minOut below a code-derived floor off the live quote (`guard#DEFAULT_MAX_SLIPPAGE_BPS` = 500 /
   5% default). `guardBuy`/`guardSell` forward `ctx.quotedAmountOutWei` (buy) /
   `args.valueOfProposedWei` (sell, already the live sell quote's own output) into this check;
   `src/tools#executeGuardedTrade` threads the fetched quote's `amountOut` through as
   `guardCtx.quotedAmountOutWei` (rescaled proportionally on the post-clip rescaled recheck too).
3. **[high] The decider's own JSON reply (`DeciderResult.actions`) was trusted at face value —
   never cross-checked against what the guarded MCP tool call actually returned** — a
   hallucinating or prompt-manipulated session could fabricate a schema-valid `ok:true` action
   (or one the guard actually rejected) that would still be recorded to the ledger and reported
   to the owner as a real trade. **Fixed:** `src/tools#appendToolCallLog` (new) has
   `bin/mcp-server.mjs`'s own `hartii_buy`/`hartii_sell` handlers append every REAL result to an
   append-only JSON-lines file at `ctx.toolCallLogPath` (wired only for decider-role sessions, via
   a new `--log-file <path>` flag `src/agents` passes pointing inside that session's own sandbox
   dir, read back before the sandbox is cleaned up). `src/agents#reconcileDeciderActions` (new,
   applied automatically inside `runDecider`) cross-checks the decider's claimed actions against
   that real log — a claimed action with no matching real entry is DROPPED (never
   recorded/reported); a matched one has every outcome field overwritten by the real result.
4. **[medium] Nothing stopped two `bin/run.mjs` processes from running concurrently against the
   same vault/ledger** — each would independently clip its own trade to <=40% of its own
   (potentially stale) portfolio snapshot, together exceeding the intended per-cycle risk cap,
   and the second to finish could silently clobber the first's freshly recorded ledger trade.
   **Fixed:** `bin/run.mjs#acquireRunLock`/`resolveLockFilePath` (new) — an O_EXCL-created
   `state/run.lock` containing the holder's pid, reclaimed automatically if that pid is no longer
   alive (stale-crash recovery), refusing to start with a clear error otherwise. Acquired first
   thing in `main()`, released on normal exit and on SIGINT/SIGTERM.

All 4 fixes covered by new tests (`test/runner.test.mjs`, `test/guard.test.mjs`,
`test/tools.test.mjs`, `test/agents.test.mjs`, `test/bin.test.mjs`) — see each file's
"(security fix)"-labeled tests. Full suite green after (`npm test`); `node bin/run.mjs --paper
--once` re-run for real after.
