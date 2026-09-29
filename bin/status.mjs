#!/usr/bin/env node
// bin/status.mjs — reads and pretty-prints state/status.json via src/runner#readStatus.
// See INTERFACES.md#bin.
import { pathToFileURL } from 'node:url';
import { readStatus } from '../src/runner/index.mjs';

const DEFAULT_STATUS_FILE = 'state/status.json';

export function parseArgs(argv) {
  const args = { help: false, file: DEFAULT_STATUS_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--file') args.file = argv[++i];
  }
  return args;
}

export function printHelp(write = (s) => process.stdout.write(s)) {
  write(`Usage: node bin/status.mjs [--file <path>]

Reads and pretty-prints the runner's status.json (default: ${DEFAULT_STATUS_FILE}).

  --file <path>   status file to read
  --help          show this help and exit 0
`);
}

function formatStatus(status) {
  if (!status) return 'No status.json yet — the runner has not completed a cycle.';
  const lines = [
    `mode:            ${status.paperMode ? 'PAPER' : 'LIVE'}`,
    `cycles run:      ${status.cyclesRun}`,
    `last cycle at:   ${status.lastCycleAtMs ? new Date(status.lastCycleAtMs).toISOString() : 'n/a'}`,
    `vault QUAI:      ${status.portfolio?.quaiWei ?? 'n/a'}`,
    `total value:     ${status.portfolio?.totalValueWei ?? 'n/a'}`,
    `realized PnL:    ${status.realizedPnlWei ?? 'n/a'}`,
    `growth vs dep.:  ${typeof status.growthPct === 'number' ? `${status.growthPct.toFixed(2)}%` : 'n/a'}`,
    `last error:      ${status.lastError ?? 'none'}`,
  ];
  return lines.join('\n');
}

export async function runStatusCli(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const args = parseArgs(argv);

  if (args.help) {
    printHelp(write);
    return 0;
  }

  const status = await readStatus(args.file, io.readImpl);
  write(`${formatStatus(status)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStatusCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
