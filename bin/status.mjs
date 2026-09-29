#!/usr/bin/env node
// bin/status.mjs — reads and pretty-prints state/status.json via src/runner#readStatus.
// See INTERFACES.md#bin.
//
// Scaffold status: --help works; reading real status is not implemented yet.

function parseArgs(argv) {
  const args = { help: false, file: 'state/status.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--file') args.file = argv[++i];
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/status.mjs [--file <path>]

Reads and pretty-prints the runner's status.json (default: state/status.json).

  --file <path>   status file to read
  --help          show this help and exit 0
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  throw new Error('bin/status.mjs: not implemented — see INTERFACES.md#bin (src/runner#readStatus)');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
