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
function, no other module depends on its internals.
