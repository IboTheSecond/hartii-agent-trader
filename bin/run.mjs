#!/usr/bin/env node
// bin/run.mjs — wires src/config -> src/data/src/chain -> src/tools -> src/agents ->
// src/runner. See INTERFACES.md#bin.
//
// Flags: --once (single cycle, exit), --loop (default interval loop), --paper (force paper
// mode), --live (required together with real keys to ever send a transaction), --dry-run
// (build+log calldata, never send), --help.
//
// Safety: this script refuses to proceed into a live loop unless BOTH a real key resolves
// (src/config#loadConfig's own env-driven paperMode logic) AND --live was explicitly passed —
// a key being present in the environment is never, on its own, enough to start sending real
// transactions. --paper / --dry-run are mirrored onto process.env (not just a local config
// override) so any subprocess src/agents spawns for an analyst/decider inherits the same
// paper/dry-run posture — see INTERFACE-REQUESTS.md: DeciderInput has no config/paperMode field,
// so a spawned `claude -p` session's own MCP server is expected to read these the same way this
// process does (loadConfig(process.env)), not receive them relayed through the decider input.
import { pathToFileURL } from 'node:url';
import { Wallet } from 'quais';

import { loadConfig, getAgentKeyMaterial } from '../src/config/index.mjs';
import { createApiClient } from '../src/data/index.mjs';
import { getProvider } from '../src/chain/index.mjs';
import { loadLedger, recordDeposit, saveLedger } from '../src/ledger/index.mjs';
import { createReporter } from '../src/report/index.mjs';
import { runCycle, runLoop } from '../src/runner/index.mjs';
import { DEFAULT_PAPER_STARTING_QUAI_WEI } from '../src/sim/index.mjs';

export function parseArgs(argv) {
  const args = { help: false, once: false, loop: false, paper: false, live: false, dryRun: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--once') args.once = true;
    else if (a === '--loop') args.loop = true;
    else if (a === '--paper') args.paper = true;
    else if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.dryRun = true;
    else {
      process.stderr.write(`warning: unrecognized flag "${a}" (see --help)\n`);
    }
  }
  return args;
}

export function printHelp(write = (s) => process.stdout.write(s)) {
  write(`Usage: node bin/run.mjs [--once | --loop] [--paper | --live] [--dry-run]

  --once      run a single cycle and exit
  --loop      run the interval loop (default if neither --once nor --loop is given)
  --paper     force paper mode regardless of configured keys (default when no live key present)
  --live      required, together with a real agent key, to ever send a real transaction
  --dry-run   build and log intended calldata, never call src/chain's sending functions
  --help      show this help and exit 0
`);
}

/**
 * Builds a RunnerCtx from CLI args + the environment. Exported (rather than inlined in main())
 * so tests can exercise the wiring logic without spawning a process or touching the network —
 * every dependency it constructs (api, provider, ledger, reporter) is itself injectable at the
 * src/* module level, this function just assembles them the way a real run does.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {NodeJS.ProcessEnv} [env] mutated in place for --paper/--dry-run (see module header)
 * @returns {Promise<object>} RunnerCtx
 */
export async function buildRunnerCtx(args, env = process.env) {
  if (args.paper) env.HARTII_PAPER = '1';
  if (args.dryRun) env.HARTII_DRY_RUN = '1';

  const config = loadConfig(env);

  if (!config.paperMode && !args.live) {
    throw new Error(
      'refusing to start: config resolved to LIVE mode (a real agent key is configured and HARTII_PAPER is not set) but --live was not passed. ' +
        'Pass --paper to rehearse instead, or --live to explicitly confirm real funds are at risk.',
    );
  }

  const api = createApiClient({ apiBase: config.apiBase });
  const provider = getProvider(config.rpcUrl);

  let wallet = null;
  if (config.hasAgentKey && !config.paperMode) {
    wallet = new Wallet(getAgentKeyMaterial(config), provider);
  }

  const ledger = await loadLedger(config.ledgerFile);
  const reporter = createReporter(config);

  return { config, api, provider, wallet, ledger, reporter };
}

function stringifyResult(result) {
  return JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
}

/**
 * Paper mode has no real vault to fund from. The first time a ledger is ever used in paper mode
 * (nothing deposited yet — a genuinely fresh ledger), seed it with a one-time simulated starting
 * balance so a brand new paper session can actually place its first buy instead of forever
 * reading a 0 QUAI balance (see src/sim#DEFAULT_PAPER_STARTING_QUAI_WEI +
 * #derivePaperPortfolioFromLedger — that constant already existed but nothing wired it to an
 * actual ledger deposit). A no-op once any deposit has ever been recorded (a real top-up or a
 * prior seed), and a no-op in live mode entirely. Persisted to disk immediately (not left as an
 * in-memory-only ctx.ledger mutation) so every mcp-server subprocess src/agents spawns for this
 * run's analysts/decider reads the same seeded state back via its own loadLedger call — kept out
 * of buildRunnerCtx (which tests call directly against a real, uninjected src/ledger) so the unit
 * test suite never writes to state/ledger.json as a side effect.
 * @param {object} ctx RunnerCtx (mutated: ctx.ledger is replaced with the seeded ledger)
 * @param {{ recordDepositImpl?: Function, saveLedgerImpl?: Function, nowFn?: Function, amountWei?: bigint }} [opts]
 * @returns {Promise<boolean>} true if a seed deposit was recorded
 */
export async function seedPaperLedgerIfFresh(ctx, opts = {}) {
  const {
    recordDepositImpl = recordDeposit,
    saveLedgerImpl = saveLedger,
    nowFn = Date.now,
    amountWei = DEFAULT_PAPER_STARTING_QUAI_WEI,
  } = opts;

  if (!ctx.config?.paperMode) return false;
  const ledger = ctx.ledger;
  const alreadyFunded = !ledger || (Array.isArray(ledger.deposits) && ledger.deposits.length > 0) || ledger.totalDepositedWei !== '0';
  if (alreadyFunded) return false;

  ctx.ledger = recordDepositImpl(ledger, { amountWei, atMs: nowFn(), txHash: null });
  await saveLedgerImpl(ctx.config.ledgerFile, ctx.ledger);
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const ctx = await buildRunnerCtx(args);

  const seeded = await seedPaperLedgerIfFresh(ctx);
  if (seeded) {
    console.log(
      `hartii-agent-trader: seeded a fresh paper ledger with ${DEFAULT_PAPER_STARTING_QUAI_WEI.toString()} wei starting paper capital (no prior deposits recorded)`,
    );
  }

  console.log(
    `hartii-agent-trader starting — mode: ${ctx.config.paperMode ? 'PAPER' : 'LIVE'}${ctx.config.dryRun ? ' (dry-run)' : ''}, profile: ${ctx.config.profile}, vault: ${ctx.config.vaultAddress || '(none configured)'}`,
  );

  if (args.once) {
    const result = await runCycle(ctx);
    console.log(stringifyResult(result));
    return result.error ? 1 : 0;
  }

  // default and --loop both run the continuous loop (--once is the only single-shot mode).
  await runLoop(ctx);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err?.message || err);
      process.exitCode = 1;
    });
}
