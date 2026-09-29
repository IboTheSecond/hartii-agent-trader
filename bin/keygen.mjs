#!/usr/bin/env node
// bin/keygen.mjs — grinds a Cyprus-1-prefixed (0x00) keypair, writes the key to a file
// (--out <path>, mode 0600), prints only the resulting address to stdout. Never prints the
// key. See INTERFACES.md#bin.
//
// Scaffold status: --help works; actually grinding a key is not implemented yet.

function parseArgs(argv) {
  const args = { help: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/keygen.mjs --out <path>

Grinds a Cyprus-1 (0x00-prefixed) Quai keypair and writes the private key to <path>
(mode 0600). Prints only the resulting address to stdout — the key itself is never printed.

  --out <path>   required, where to write the key file
  --help         show this help and exit 0
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.out) {
    console.error('error: --out <path> is required (see --help)');
    process.exit(1);
  }
  throw new Error('bin/keygen.mjs: key grinding not implemented — see INTERFACES.md#bin (src/chain, src/config)');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
