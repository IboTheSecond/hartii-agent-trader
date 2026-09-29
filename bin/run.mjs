#!/usr/bin/env node
// bin/run.mjs — wires src/config -> src/data/src/chain -> src/tools -> src/agents ->
// src/runner. See INTERFACES.md#bin.
//
// Flags: --once (single cycle, exit), --loop (default interval loop), --paper (force paper
// mode), --live (required together with real keys to ever send a transaction), --dry-run
// (build+log calldata, never send).
//
// Scaffold status: --help works; wiring the real cycle is not implemented yet. Paper mode is
// the default and this stub can never send a transaction — there is no code path here that
// calls src/chain#sendVaultExecute.

function parseArgs(argv) {
  const args = { help: false, once: false, loop: false, paper: false, live: false, dryRun: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--once') args.once = true;
    else if (a === '--loop') args.loop = true;
    else if (a === '--paper') args.paper = true;
    else if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/run.mjs [--once | --loop] [--paper | --live] [--dry-run]

  --once      run a single cycle and exit
  --loop      run the interval loop (default if neither --once nor --loop is given)
  --paper     force paper mode regardless of configured keys (default when no live key present)
  --live      required, together with a real agent key, to ever send a real transaction
  --dry-run   build and log intended calldata, never call src/chain's sending functions
  --help      show this help and exit 0
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  throw new Error('bin/run.mjs: cycle wiring not implemented — see INTERFACES.md#bin (src/runner)');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
