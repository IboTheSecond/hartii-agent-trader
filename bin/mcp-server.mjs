#!/usr/bin/env node
// bin/mcp-server.mjs — the MCP server subprocess src/agents spawns (over stdio) for every
// sandboxed analyst/decider `claude -p` session. Not in the original bin/ list in
// INTERFACES.md's MODULE LAYOUT — added per the integration src/agents documented it expects in
// INTERFACE-REQUESTS.md (`DEFAULT_MCP_SERVER_ENTRY` = `bin/mcp-server.mjs --role <role>`,
// server name `hartii-agent`), confirmed compatible by src/tools' own reply there.
//
// Each `claude -p` session gets a FRESH copy of this process (that's inherent to stdio MCP: the
// client spawns the server command itself), so nothing here can hold long-lived in-memory state
// across cycles or across an analyst/decider's own sessions — every ToolCtx field it builds is
// reconstructed from durable state (env vars, state/ledger.json) on every single invocation:
//   - config: loadConfig(process.env) — the same env vars bin/run.mjs's own process has, IF
//     they were passed through. src/agents' own opts.mcpServerEnv default is an EMPTY object,
//     not "inherit" — src/runner passes `{ mcpServerEnv: process.env }` explicitly to cover
//     this (see INTERFACE-REQUESTS.md and src/runner's own header comment).
//   - ledger: loadLedger(config.ledgerFile) — the durable ledger.json, not an in-memory object.
//   - paperEngine (paper mode only): a fresh PaperEngine seeded from that same ledger via
//     src/sim#derivePaperPortfolioFromLedger (cash) + its positions (token holdings) — see
//     src/sim's own header comment on why this reconstruction, not a shared object, is correct.
//
// Known limitation (documented, not silently papered over): src/tools' hartii_status /
// hartii_buy / hartii_sell all read `ctx.api.getVault(ctx.vault)` for portfolio-sizing context
// even in paper mode (see INTERFACE-REQUESTS.md) — so a PURE paper session with no
// HARTII_VAULT_ADDRESS configured at all will have hartii_status/hartii_buy/hartii_sell tool
// calls fail even though the decider's own prompt-embedded context (built by src/runner from
// the ledger) is still accurate. Configuring a real (even unfunded) vault address is recommended
// for paper rehearsals until that's reconciled — see README's Running section.
import { pathToFileURL } from 'node:url';
import { Wallet } from 'quais';

import { loadConfig, getAgentKeyMaterial } from '../src/config/index.mjs';
import { createApiClient } from '../src/data/index.mjs';
import { getProvider } from '../src/chain/index.mjs';
import * as ledgerApi from '../src/ledger/index.mjs';
import { createPaperEngine, derivePaperPortfolioFromLedger } from '../src/sim/index.mjs';
import { buildReadOnlyTools, buildTradeTools, createMcpServer, serveStdio, resolveAllowlist } from '../src/tools/index.mjs';

const MCP_SERVER_NAME = 'hartii-agent'; // must match src/agents#MCP_SERVER_NAME — see header comment above

export function parseArgs(argv) {
  const args = { help: false, role: null, logFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--role') args.role = argv[++i];
    else if (a === '--log-file') args.logFile = argv[++i];
  }
  return args;
}

export function printHelp(write = (s) => process.stdout.write(s)) {
  write(`Usage: node bin/mcp-server.mjs --role <momentumScout|riskAnalyst|portfolioManager|decider> [--log-file <path>]

Internal — spawned by src/agents as the MCP server for one sandboxed claude -p session. Not
meant to be run by hand except to sanity-check the wiring; --help lists this and exits 0.
--log-file (decider only): an append-only JSON-lines path src/tools#appendToolCallLog writes
every real hartii_buy/hartii_sell result to, so src/agents#runDecider can reconcile the model's
own self-reported DeciderResult.actions against what actually happened (see the security fix
this closes — never trust the decider's claims at face value).
`);
}

function parseApprovedImageUrls(env) {
  const raw = env.HARTII_APPROVED_IMAGE_URLS;
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Builds the ToolCtx for this subprocess. Exported so a test can exercise the wiring logic with
 * injected api/provider/loadLedger without needing a real config/network/filesystem.
 * @param {{ config: object, apiFactory?: Function, providerFactory?: Function, loadLedgerImpl?: Function, walletFactory?: Function, env?: NodeJS.ProcessEnv }} opts
 */
export async function buildToolCtx({
  config,
  apiFactory = createApiClient,
  providerFactory = getProvider,
  loadLedgerImpl = ledgerApi.loadLedger,
  walletFactory = (key, provider) => new Wallet(key, provider),
  getAgentKeyMaterialImpl = getAgentKeyMaterial,
  env = process.env,
  toolCallLogPath = null,
} = {}) {
  const api = apiFactory({ apiBase: config.apiBase });
  const provider = providerFactory(config.rpcUrl);

  let wallet = null;
  if (config.hasAgentKey && !config.paperMode) {
    wallet = walletFactory(getAgentKeyMaterialImpl(config), provider);
  }

  const ledger = await loadLedgerImpl(config.ledgerFile);

  let paperEngine = null;
  if (config.paperMode) {
    const { quaiWei, positions } = derivePaperPortfolioFromLedger(ledger);
    paperEngine = createPaperEngine({ initialQuaiWei: quaiWei, api, initialPositions: positions });
  }

  return {
    api,
    provider,
    wallet,
    vault: config.vaultAddress,
    config,
    ledger,
    ledgerApi,
    paperEngine,
    launchState: { count: 0, lastAtMs: null },
    approvedImageUrls: parseApprovedImageUrls(env),
    // See src/tools#appendToolCallLog / src/agents#reconcileDeciderActions — the real-result log
    // src/agents' decider session reads back and reconciles its own self-reported actions
    // against. null for every non-decider role (src/agents never passes --log-file to them).
    toolCallLogPath,
  };
}

export function buildRoleTools(role, ctx, config) {
  const allowlist = new Set(resolveAllowlist(role, config));
  const all = role === 'decider' ? [...buildReadOnlyTools(ctx), ...buildTradeTools(ctx)] : buildReadOnlyTools(ctx);
  // Belt-and-braces: filter to exactly this role's allowlist even though buildReadOnlyTools/
  // buildTradeTools already return a fixed, role-appropriate-ish set — a stray extra tool must
  // never leak past even a bug elsewhere (same principle as src/guard's trust-boundary stance).
  return all.filter((t) => allowlist.has(t.name));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.role) {
    process.stderr.write('error: --role <momentumScout|riskAnalyst|portfolioManager|decider> is required\n');
    return 1;
  }

  const config = loadConfig(env);
  const ctx = await buildToolCtx({ config, env, toolCallLogPath: args.logFile });
  const tools = buildRoleTools(args.role, ctx, config);
  const server = createMcpServer(tools, { name: MCP_SERVER_NAME });
  await serveStdio(server);
  return 0; // never actually reached while the stdio transport is open — kept for testability
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err?.message || err}\n`);
      process.exitCode = 1;
    });
}
