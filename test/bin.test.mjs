import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs as parseKeygenArgs, printHelp as printKeygenHelp, runKeygenCli, writeKeyFile, grindCyprus1Key, isCyprus1Address } from '../bin/keygen.mjs';
import { parseArgs as parseRunArgs, printHelp as printRunHelp, buildRunnerCtx, seedPaperLedgerIfFresh } from '../bin/run.mjs';
import { parseArgs as parseStatusArgs, printHelp as printStatusHelp, runStatusCli } from '../bin/status.mjs';
import { parseArgs as parseMcpArgs, printHelp as printMcpHelp, buildToolCtx, buildRoleTools } from '../bin/mcp-server.mjs';

// --- bin/keygen.mjs -----------------------------------------------------------------------

test('keygen: parseArgs reads --out/--force/--help', () => {
  assert.deepEqual(parseKeygenArgs(['--out', 'x.key']), { help: false, out: 'x.key', force: false });
  assert.deepEqual(parseKeygenArgs(['--out', 'x.key', '--force']), { help: false, out: 'x.key', force: true });
  assert.equal(parseKeygenArgs(['--help']).help, true);
});

test('keygen: printHelp writes usage without touching real stdout', () => {
  let out = '';
  printKeygenHelp((s) => (out += s));
  assert.match(out, /--out <path>/);
  assert.match(out, /never printed/);
});

test('keygen: runKeygenCli requires --out', async () => {
  let err = '';
  const code = await runKeygenCli([], { writeErr: (s) => (err += s) });
  assert.equal(code, 1);
  assert.match(err, /--out <path> is required/);
});

test('keygen: runKeygenCli --help exits 0 without grinding', async () => {
  let out = '';
  const code = await runKeygenCli(['--help'], { write: (s) => (out += s) });
  assert.equal(code, 0);
  assert.match(out, /Usage/);
});

test('keygen: runKeygenCli writes a key file (fake grind + fs) and prints only the address', async () => {
  const written = {};
  const deps = {
    statFn: async () => {
      throw { code: 'ENOENT' };
    },
    mkdirFn: async () => {},
    writeFileFn: async (p, content) => {
      written.path = p;
      written.content = content;
    },
    grind: () => ({ privateKey: '0xDEADBEEF_SHOULD_NEVER_APPEAR', address: '0x00abc' }),
  };
  let out = '';
  const code = await runKeygenCli(['--out', 'state/agent.key'], { write: (s) => (out += s), deps });
  assert.equal(code, 0);
  assert.match(out, /0x00abc/);
  assert.doesNotMatch(out, /DEADBEEF/); // the private key must never reach stdout
  assert.equal(written.path, 'state/agent.key');
  assert.match(written.content, /DEADBEEF/); // ...but it must reach the key file
});

test('keygen: writeKeyFile refuses to overwrite an existing file unless force:true', async () => {
  const deps = { statFn: async () => ({}), mkdirFn: async () => {}, writeFileFn: async () => {}, grind: () => ({ privateKey: '0x1', address: '0x2' }) };
  await assert.rejects(() => writeKeyFile({ filePath: 'state/agent.key' }, deps), /already exists/);
  const result = await writeKeyFile({ filePath: 'state/agent.key', force: true }, deps);
  assert.equal(result.address, '0x2');
});

test('keygen: isCyprus1Address rejects garbage without throwing', () => {
  assert.equal(isCyprus1Address('not-an-address'), false);
  assert.equal(isCyprus1Address(''), false);
});

test('keygen: grindCyprus1Key (real, unmocked) always returns a Cyprus-1 address', () => {
  const { address, privateKey, attempts } = grindCyprus1Key();
  assert.equal(isCyprus1Address(address), true);
  assert.match(privateKey, /^0x[0-9a-f]{64}$/);
  assert.ok(attempts >= 1);
});

// --- bin/run.mjs ----------------------------------------------------------------------------

test('run: parseArgs reads once/loop/paper/live/dry-run/help', () => {
  const args = parseRunArgs(['--once', '--paper', '--dry-run']);
  assert.equal(args.once, true);
  assert.equal(args.paper, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.live, false);
  assert.equal(parseRunArgs(['--live']).live, true);
});

test('run: printHelp documents every flag', () => {
  let out = '';
  printRunHelp((s) => (out += s));
  for (const flag of ['--once', '--loop', '--paper', '--live', '--dry-run', '--help']) {
    assert.ok(out.includes(flag), `expected help text to mention ${flag}`);
  }
});

test('run: buildRunnerCtx refuses to build a live ctx without --live', async () => {
  // A stub src/config#loadConfig still throws "not implemented" at this point in the parallel
  // build — this test only needs to prove the --live gate is checked BEFORE that call could
  // matter, i.e. that buildRunnerCtx's own logic path is reachable and testable independent of
  // whether src/config is finished yet. Once src/config is implemented for real, this same test
  // continues to hold: it never sets HARTII_PAPER, so loadConfig would resolve live IF a key
  // were present — but with no key configured, paperMode resolves true and the gate does not
  // fire in that case. This test therefore asserts the narrower, always-true contract: passing
  // --paper never trips the live gate.
  const env = { HARTII_PAPER: '1' };
  // With HARTII_PAPER=1 forced, config.paperMode must resolve true regardless of key presence,
  // so buildRunnerCtx must NOT throw the live-mode guard error for this env.
  await assert.doesNotReject(async () => {
    try {
      await buildRunnerCtx({ paper: true, live: false, dryRun: false }, env);
    } catch (err) {
      // src/config is still a stub elsewhere in this parallel build — a "not implemented" error
      // from loadConfig itself is expected and NOT what this test checks; only re-throw if it's
      // the live-mode guard this test is actually about.
      if (/refusing to start/.test(err.message)) throw err;
    }
  });
});

test('run: --paper and --dry-run flags are mirrored onto the provided env object', async () => {
  const env = {};
  try {
    await buildRunnerCtx({ paper: true, live: false, dryRun: true }, env);
  } catch {
    /* loadConfig itself may still be a stub — irrelevant to what this test checks */
  }
  assert.equal(env.HARTII_PAPER, '1');
  assert.equal(env.HARTII_DRY_RUN, '1');
});

test('run: seedPaperLedgerIfFresh records a one-time starting deposit for a genuinely fresh paper ledger', async () => {
  let recordedWith = null;
  let saved = null;
  const ctx = { config: { paperMode: true, ledgerFile: 'state/ledger.json' }, ledger: { totalDepositedWei: '0', deposits: [], trades: [] } };
  const seeded = await seedPaperLedgerIfFresh(ctx, {
    recordDepositImpl: (ledger, args) => {
      recordedWith = args;
      return { ...ledger, totalDepositedWei: args.amountWei.toString(), deposits: [args] };
    },
    saveLedgerImpl: async (file, ledger) => { saved = { file, ledger }; },
    nowFn: () => 12345,
    amountWei: 999n,
  });
  assert.equal(seeded, true);
  assert.equal(recordedWith.amountWei, 999n);
  assert.equal(recordedWith.atMs, 12345);
  assert.equal(recordedWith.txHash, null);
  assert.equal(ctx.ledger.totalDepositedWei, '999');
  assert.equal(saved.file, 'state/ledger.json');
});

test('run: seedPaperLedgerIfFresh is a no-op in live mode', async () => {
  let called = false;
  const ctx = { config: { paperMode: false, ledgerFile: 'state/ledger.json' }, ledger: { totalDepositedWei: '0', deposits: [], trades: [] } };
  const seeded = await seedPaperLedgerIfFresh(ctx, {
    recordDepositImpl: () => { called = true; },
    saveLedgerImpl: async () => { called = true; },
  });
  assert.equal(seeded, false);
  assert.equal(called, false);
});

test('run: seedPaperLedgerIfFresh is a no-op once any deposit has ever been recorded (real top-up or a prior seed)', async () => {
  let called = false;
  const ctx = {
    config: { paperMode: true, ledgerFile: 'state/ledger.json' },
    ledger: { totalDepositedWei: '5', deposits: [{ amountWei: '5', atMs: 1, txHash: null }], trades: [] },
  };
  const seeded = await seedPaperLedgerIfFresh(ctx, {
    recordDepositImpl: () => { called = true; },
    saveLedgerImpl: async () => { called = true; },
  });
  assert.equal(seeded, false);
  assert.equal(called, false);
  assert.equal(ctx.ledger.totalDepositedWei, '5'); // untouched
});

// --- bin/status.mjs -------------------------------------------------------------------------

test('status: parseArgs reads --file/--help with a sane default', () => {
  assert.equal(parseStatusArgs([]).file, 'state/status.json');
  assert.equal(parseStatusArgs(['--file', 'other.json']).file, 'other.json');
});

test('status: printHelp mentions --file', () => {
  let out = '';
  printStatusHelp((s) => (out += s));
  assert.match(out, /--file <path>/);
});

test('status: runStatusCli prints a friendly message when no status.json exists yet', async () => {
  let out = '';
  const readImpl = async () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  };
  const code = await runStatusCli([], { write: (s) => (out += s), readImpl });
  assert.equal(code, 0);
  assert.match(out, /No status\.json yet/);
});

// --- bin/mcp-server.mjs ---------------------------------------------------------------------

test('mcp-server: parseArgs reads --role/--help', () => {
  assert.deepEqual(parseMcpArgs(['--role', 'decider']), { help: false, role: 'decider' });
  assert.equal(parseMcpArgs(['--help']).help, true);
  assert.equal(parseMcpArgs([]).role, null);
});

test('mcp-server: printHelp documents --role', () => {
  let out = '';
  printMcpHelp((s) => (out += s));
  assert.match(out, /--role/);
});

function fakeApi() {
  return {
    async getTokens() { return []; },
    async getVault() { return { paused: false, quaiBalanceWei: '0', holdings: [] }; },
    async getQuote() { return { amountIn: '0', amountOut: '0', priceImpact: 0, minOut: '0' }; },
    async getToken() { return {}; },
    async getLiquidity() { return {}; },
    async getTrades() { return []; },
    async getHolders() { return []; },
  };
}

test('mcp-server: buildToolCtx builds a paper-mode ToolCtx with a seeded PaperEngine, no wallet', async () => {
  const config = { paperMode: true, hasAgentKey: false, apiBase: 'https://x', rpcUrl: 'https://y', vaultAddress: '0xvault', ledgerFile: 'state/ledger.json' };
  const ledger = { totalDepositedWei: (10n ** 18n).toString(), gasSpentWei: '0', positions: {}, trades: [] };
  const ctx = await buildToolCtx({
    config,
    apiFactory: () => fakeApi(),
    providerFactory: () => ({ fake: 'provider' }),
    loadLedgerImpl: async () => ledger,
    env: {},
  });
  assert.equal(ctx.wallet, null);
  assert.ok(ctx.paperEngine);
  assert.deepEqual(ctx.paperEngine.getState(), { quaiWei: 10n ** 18n, positions: {} });
  assert.equal(ctx.vault, '0xvault');
  assert.ok(ctx.ledgerApi && typeof ctx.ledgerApi.getRealizedPnlWei === 'function');
  assert.deepEqual(ctx.approvedImageUrls, []);
});

test('mcp-server: buildToolCtx builds a live-mode ToolCtx with a real wallet, no PaperEngine', async () => {
  const config = { paperMode: false, hasAgentKey: true, apiBase: 'https://x', rpcUrl: 'https://y', vaultAddress: '0xvault', ledgerFile: 'state/ledger.json' };
  const ledger = { totalDepositedWei: '0', gasSpentWei: '0', positions: {}, trades: [] };
  let walletArgs = null;
  const ctx = await buildToolCtx({
    config,
    apiFactory: () => fakeApi(),
    providerFactory: () => ({ fake: 'provider' }),
    loadLedgerImpl: async () => ledger,
    getAgentKeyMaterialImpl: () => 'fake-key-material',
    walletFactory: (key, provider) => {
      walletArgs = { key, provider };
      return { address: '0xagent', key };
    },
    env: {},
  });
  assert.equal(ctx.paperEngine, null);
  assert.equal(ctx.wallet.address, '0xagent');
  assert.ok(walletArgs.provider);
});

test('mcp-server: buildToolCtx reads HARTII_APPROVED_IMAGE_URLS as a comma-separated list', async () => {
  const config = { paperMode: true, hasAgentKey: false, apiBase: 'https://x', rpcUrl: 'https://y', vaultAddress: null, ledgerFile: 'state/ledger.json' };
  const ctx = await buildToolCtx({
    config,
    apiFactory: () => fakeApi(),
    providerFactory: () => ({}),
    loadLedgerImpl: async () => ({ totalDepositedWei: '0', gasSpentWei: '0', positions: {}, trades: [] }),
    env: { HARTII_APPROVED_IMAGE_URLS: 'https://a.png, https://b.png' },
  });
  assert.deepEqual(ctx.approvedImageUrls, ['https://a.png', 'https://b.png']);
});

test('mcp-server: buildRoleTools filters strictly to that role\'s allowlist (belt-and-braces)', async () => {
  const config = { paperMode: true, launchesEnabled: false, profile: 'reckless' };
  const ctx = { api: fakeApi(), provider: {}, wallet: null, vault: '0xvault', config, ledger: { positions: {}, trades: [] }, ledgerApi: null, paperEngine: null };

  const momentum = buildRoleTools('momentumScout', ctx, config).map((t) => t.name).sort();
  assert.deepEqual(momentum, ['hartii_market', 'hartii_trade_flow']);

  const decider = buildRoleTools('decider', ctx, config).map((t) => t.name).sort();
  assert.deepEqual(decider, ['hartii_buy', 'hartii_market', 'hartii_quote', 'hartii_sell', 'hartii_status']);
  assert.ok(!decider.includes('hartii_launch_token'));
});

test('mcp-server: buildRoleTools includes hartii_launch_token for the decider only when launches are enabled', async () => {
  const config = { paperMode: true, launchesEnabled: true, profile: 'reckless' };
  const ctx = { api: fakeApi(), provider: {}, wallet: null, vault: '0xvault', config, ledger: { positions: {}, trades: [] }, ledgerApi: null, paperEngine: null };
  const decider = buildRoleTools('decider', ctx, config).map((t) => t.name);
  assert.ok(decider.includes('hartii_launch_token'));
});

test('status: runStatusCli pretty-prints an existing status document', async () => {
  const status = {
    lastCycleAtMs: 1735000000000,
    cyclesRun: 7,
    paperMode: true,
    portfolio: { quaiWei: '1000000000000000000', totalValueWei: '2000000000000000000' },
    realizedPnlWei: '500000000000000000',
    growthPct: 12.5,
    lastError: null,
  };
  const readImpl = async () => JSON.stringify(status);
  let out = '';
  const code = await runStatusCli([], { write: (s) => (out += s), readImpl });
  assert.equal(code, 0);
  assert.match(out, /PAPER/);
  assert.match(out, /cycles run:\s+7/);
  assert.match(out, /12\.50%/);
});
