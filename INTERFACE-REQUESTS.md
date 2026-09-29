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
