#!/usr/bin/env node
// bin/keygen.mjs — grinds a Cyprus-1-prefixed Quai keypair entirely on this machine (never
// touches the network), and writes the private key to a file (--out <path>, mode 0600 —
// best-effort on Windows, which ignores POSIX modes). Prints ONLY the resulting address to
// stdout; the private key itself is never printed, logged, or returned from writeKeyFile's
// caller-visible fields. See INTERFACES.md#bin.
//
// Quai addresses are zone-sharded — only about 1/512 random keys land in Cyprus-1 — so this
// grinds fresh random keys until one does. Same approach the reference prototype's
// lib/keyfile.mjs uses (re-implemented here, not imported — see the repo-level clean-room rule).
import { Wallet, isQuaiAddress, getZoneForAddress, Zone } from 'quais';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { mkdir as nodeMkdir, writeFile as nodeWriteFile, stat as nodeStat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_KEY_FILE = 'state/agent.key';

export function isCyprus1Address(address) {
  try {
    return isQuaiAddress(address) && getZoneForAddress(address) === Zone.Cyprus1;
  } catch {
    return false;
  }
}

/**
 * Pure/local: reads only from the supplied random source, never touches the filesystem or
 * network. Runs until it finds a Cyprus-1 address — unbounded in theory, ~512 attempts on
 * average in practice.
 * @param {{ randomBytesFn?: (n: number) => Buffer | Uint8Array }} [opts]
 * @returns {{ privateKey: string, address: string, attempts: number }}
 */
export function grindCyprus1Key({ randomBytesFn = nodeRandomBytes } = {}) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const privateKey = `0x${Buffer.from(randomBytesFn(32)).toString('hex')}`;
    const wallet = new Wallet(privateKey);
    if (isCyprus1Address(wallet.address)) {
      return { privateKey, address: wallet.address, attempts };
    }
  }
}

/**
 * Grinds a fresh Cyprus-1 agent key and writes it to `filePath` with owner-only permissions.
 * Refuses to overwrite an existing file unless `force` is true, so a second accidental run can
 * never silently orphan a vault whose `agent` still points at the old key.
 * @param {{ filePath?: string, force?: boolean }} [opts]
 * @param {{ statFn?, mkdirFn?, writeFileFn?, grind?: typeof grindCyprus1Key }} [deps] injectable for tests
 * @returns {Promise<{ address: string, filePath: string }>}
 */
export async function writeKeyFile({ filePath = DEFAULT_KEY_FILE, force = false } = {}, deps = {}) {
  const { statFn = nodeStat, mkdirFn = nodeMkdir, writeFileFn = nodeWriteFile, grind = grindCyprus1Key } = deps;

  if (!force) {
    const exists = await statFn(filePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new Error(`${filePath} already exists — refusing to overwrite. Pass --force to replace it.`);
    }
  }

  const { privateKey, address } = grind();
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    await mkdirFn(dir, { recursive: true, mode: 0o700 }).catch(() => {});
  }
  await writeFileFn(filePath, `${privateKey}\n`, { mode: 0o600 });
  return { address, filePath };
}

export function parseArgs(argv) {
  const args = { help: false, out: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--force') args.force = true;
  }
  return args;
}

export function printHelp(write = (s) => process.stdout.write(s)) {
  write(`Usage: node bin/keygen.mjs --out <path> [--force]

Grinds a Cyprus-1 (zone-sharded) Quai keypair entirely on this machine and writes the private
key to <path> (mode 0600). Prints only the resulting address to stdout — the key itself is
never printed.

  --out <path>   required, where to write the key file
  --force        overwrite an existing key file at <path> instead of refusing
  --help         show this help and exit 0
`);
}

export async function runKeygenCli(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const args = parseArgs(argv);

  if (args.help) {
    printHelp(write);
    return 0;
  }
  if (!args.out) {
    writeErr('error: --out <path> is required (see --help)\n');
    return 1;
  }

  try {
    const { address, filePath } = await writeKeyFile({ filePath: args.out, force: args.force }, io.deps);
    write(
      `Agent address: ${address}\nKey file: ${filePath}\n\n` +
        `Next: set HARTII_AGENT_KEY_FILE=${filePath} in your .env (never commit it — .gitignore already excludes *.key and state/).\n`,
    );
    return 0;
  } catch (err) {
    writeErr(`${err?.message || err}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKeygenCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
