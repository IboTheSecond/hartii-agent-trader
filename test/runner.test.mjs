import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCycle, runLoop, shouldStop, writeStatus, readStatus, DEFAULT_PAUSE_MIN_MS, DEFAULT_PAUSE_MAX_MS } from '../src/runner/index.mjs';
import * as realLedgerModule from '../src/ledger/index.mjs';

const QUAI = 10n ** 18n;
const TOKEN = '0x000000000000000000000000000000000000aa';
const VAULT = '0x000000000000000000000000000000000000bb';

// --- shared fakes ------------------------------------------------------------------------------

function fakeLedgerModule({ recordTradeThrows = false } = {}) {
  let ledger = { version: 1, totalDepositedWei: '0', realizedPnlWei: '0', gasSpentWei: '0', positions: {}, trades: [], deposits: [] };
  return {
    recordTrade(l, trade) {
      if (recordTradeThrows) throw new Error('boom');
      ledger = { ...l, trades: [...l.trades, trade] };
      return ledger;
    },
    recordGas(l, { gasWei }) {
      return { ...l, gasSpentWei: (BigInt(l.gasSpentWei || '0') + gasWei).toString() };
    },
    getRealizedPnlWei: () => 1n * QUAI,
    getUnrealizedPnlWei: () => -1n * QUAI,
    getGrowthPct: () => 5,
    getRecentTrades: (l, n = 5) => l.trades.slice(-n),
    async saveLedger() {
      return undefined;
    },
  };
}

function fakeAgentsModule({ proposals, deciderResult, runDeciderImpl } = {}) {
  return {
    async loadMemoryJournal() {
      return [];
    },
    summarizeMemory() {
      return '';
    },
    async runAnalystsInParallel() {
      return proposals ?? { momentumScout: [], riskAnalyst: [], portfolioManager: [] };
    },
    async runDecider(input) {
      if (runDeciderImpl) return runDeciderImpl(input);
      return deciderResult ?? { actions: [], reasoning: 'nothing looked good', skipped: 'no conviction' };
    },
  };
}

function fakeGuardModule({ killed = false } = {}) {
  return {
    async checkKillSwitch() {
      return killed;
    },
    enforceGasReserve(gasWei, thresholdWei) {
      return gasWei >= thresholdWei ? { ok: true } : { ok: false, reason: 'below gas floor' };
    },
  };
}

function fakeChainModule({ gasWei = 100n * QUAI } = {}) {
  return { async getQuaiBalanceWei() { return gasWei; } };
}

function fakeApi({ tokens, vault, getVaultImpl } = {}) {
  return {
    async getTokens() {
      return tokens ?? [{ address: TOKEN, name: 'Doge Two', symbol: 'DOGE2', status: 'active' }];
    },
    async getVault(addr) {
      if (getVaultImpl) return getVaultImpl(addr);
      return vault ?? { owner: '0xowner', agent: '0xagent', paused: false, caps: { maxPerTxWei: '0', maxPerDayWei: '0' }, spentTodayWei: '0', quaiBalanceWei: (10n * QUAI).toString(), holdings: [], recentActivity: [] };
    },
  };
}

function memoryStatusIO() {
  const files = new Map();
  return {
    readStatusImpl: async (p) => {
      if (!files.has(p)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
    writeStatusImpl: async (p, content) => {
      files.set(p, content);
    },
    files,
  };
}

function baseCtx(overrides = {}) {
  const io = memoryStatusIO();
  const deps = {
    ledger: fakeLedgerModule(),
    agents: fakeAgentsModule(),
    guard: fakeGuardModule(),
    chain: fakeChainModule(),
    sanitizeTokenText: (t) => ({ address: t.address, name: t.name, symbol: t.symbol, status: t.status }),
    getProfile: (name) => ({ name, actEveryCycle: true, sizeFractionBpsRange: [2000, 4000], maxPriceImpactPct: 8, trailingExits: true, rotateStalledAfterCycles: 2, minReserveFractionBps: 3300 }),
    now: () => 1_700_000_000_000,
    randomFn: () => 0.5,
    sleepFn: async () => {},
    readStatusImpl: io.readStatusImpl,
    writeStatusImpl: io.writeStatusImpl,
    ...overrides.deps,
  };
  const reported = { trades: [], blocked: [], hourly: [] };
  const reporter = {
    async reportTrade(trade, snapshot) {
      reported.trades.push({ trade, snapshot });
    },
    async reportHourly(snapshot) {
      reported.hourly.push(snapshot);
    },
    async reportBlocked(reason) {
      reported.blocked.push(reason);
    },
  };
  // A healthy default starting balance — tests that care specifically about an empty/exhausted
  // paper balance pass their own `ledgerState` override (see the capital-exhausted tests below).
  const ledger = { version: 1, totalDepositedWei: (1000n * QUAI).toString(), realizedPnlWei: '0', gasSpentWei: '0', positions: {}, trades: [], deposits: [] };
  const ctx = {
    config: {
      paperMode: true,
      vaultAddress: VAULT,
      maxActionsPerCycle: 3,
      profile: 'reckless',
      killSwitchFile: 'state/STOP',
      statusFile: 'state/status.json',
      ledgerFile: 'state/ledger.json',
      memoryFile: 'state/memory.json',
      ...overrides.config,
    },
    api: overrides.api ?? fakeApi(),
    provider: overrides.provider ?? {},
    wallet: overrides.wallet === undefined ? { address: '0x00wallet' } : overrides.wallet,
    ledger: overrides.ledgerState ?? ledger,
    reporter,
    deps,
  };
  return { ctx, reported, io };
}

// --- runCycle ------------------------------------------------------------------------------

test('runCycle: kill switch short-circuits the whole cycle before any market/agent call', async () => {
  const calls = [];
  const { ctx, reported } = baseCtx({
    deps: { guard: fakeGuardModule({ killed: true }) },
    api: { async getTokens() { calls.push('getTokens'); return []; }, async getVault() { calls.push('getVault'); return {}; } },
  });
  const result = await runCycle(ctx);
  assert.equal(result.stopped, true);
  assert.equal(result.stopReason, 'kill-switch');
  assert.deepEqual(calls, []); // no market/vault fetch happened
  assert.equal(reported.blocked.length, 1);
  assert.match(reported.blocked[0], /kill switch/);
});

test('runCycle: vault paused stops the cycle and is reported (live mode only — see paper-mode tests below)', async () => {
  const { ctx, reported } = baseCtx({ config: { paperMode: false }, api: fakeApi({ vault: { paused: true, quaiBalanceWei: '0', holdings: [] } }) });
  const result = await runCycle(ctx);
  assert.equal(result.stopped, true);
  assert.equal(result.stopReason, 'vault-paused');
  assert.match(reported.blocked[0], /paused/);
});

test('runCycle: happy path runs analysts + decider, records executed trades, and reports them', async () => {
  const decider = {
    actions: [{ token: TOKEN, side: 'buy', amountWei: (1n * QUAI).toString(), amountOutWei: (100n * QUAI).toString(), txHash: null, ok: true, warnings: [] }],
    reasoning: 'momentum looked strong',
    skipped: null,
  };
  const { ctx, reported } = baseCtx({ deps: { agents: fakeAgentsModule({ deciderResult: decider }) } });

  const result = await runCycle(ctx);

  assert.equal(result.stopped, false);
  assert.equal(result.decider.actions.length, 1);
  assert.equal(reported.trades.length, 1);
  const [{ trade, snapshot }] = reported.trades;
  assert.equal(trade.side, 'buy');
  assert.equal(trade.token, TOKEN);
  assert.equal(trade.amountQuaiWei, (1n * QUAI).toString());
  assert.equal(trade.amountTokenWei, (100n * QUAI).toString());
  assert.equal(trade.symbol, 'DOGE2'); // recovered from the sanitized market candidate
  assert.equal(trade.paper, true);
  assert.equal(snapshot.realizedPnlWei, (1n * QUAI).toString());
  assert.ok(ctx.ledger.trades.length === 1); // ctx.ledger carried forward for the next cycle
});

test('runCycle: in paper mode, a trade\'s own reported snapshot reflects the balance AFTER that trade, not the stale pre-cycle balance', async () => {
  // Uses the real src/ledger + src/sim modules (pure, no I/O) instead of the fake — the fake's
  // recordTrade never updated .positions/derived balances, which is exactly what would have
  // masked this bug (confirmed live: a real run's trade report showed the pre-trade QUAI balance
  // unchanged by the trade it was reporting — see INTERFACE-REQUESTS.md's integration entry).
  const decider = {
    actions: [{ token: TOKEN, side: 'buy', amountWei: (100n * QUAI).toString(), amountOutWei: (50n * QUAI).toString(), txHash: null, ok: true, warnings: [] }],
    reasoning: 'strong signal',
    skipped: null,
  };
  const { ctx, reported, io } = baseCtx({
    deps: { ledger: realLedgerModule, agents: fakeAgentsModule({ deciderResult: decider }) },
  });

  await runCycle(ctx);

  assert.equal(reported.trades.length, 1);
  const { snapshot } = reported.trades[0];
  // Started at 1000 QUAI deposited (baseCtx's default), spent 100 QUAI on this buy: 900 left —
  // never the stale pre-trade 1000.
  assert.equal(snapshot.quaiWei, (900n * QUAI).toString());
  assert.equal(snapshot.holdings.length, 1);
  assert.equal(snapshot.holdings[0].amountWei, (50n * QUAI).toString());

  // The cycle's own final status.json must agree — not lag one cycle behind.
  const status = JSON.parse(await io.readStatusImpl(ctx.config.statusFile));
  assert.equal(status.portfolio.quaiWei, (900n * QUAI).toString());
});

test('runCycle: an unexecuted (ok:false) action is never recorded as a trade', async () => {
  const decider = { actions: [{ token: TOKEN, side: 'buy', amountWei: '1', ok: false, warnings: ['clipped to zero'] }], reasoning: 'tried and failed', skipped: null };
  const { ctx, reported } = baseCtx({ deps: { agents: fakeAgentsModule({ deciderResult: decider }) } });
  const result = await runCycle(ctx);
  assert.equal(reported.trades.length, 0);
  assert.equal(result.decider.actions.length, 1); // still reported in the CycleResult, just not ledgered
});

test('runCycle: caps executed actions at config.maxActionsPerCycle even if the decider returns more', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ token: TOKEN, side: 'buy', amountWei: '1', amountOutWei: '1', ok: true, warnings: [], symbol: `T${i}` }));
  const { ctx, reported } = baseCtx({
    config: { maxActionsPerCycle: 2 },
    deps: { agents: fakeAgentsModule({ deciderResult: { actions: many, reasoning: 'x', skipped: null } }) },
  });
  const result = await runCycle(ctx);
  assert.equal(result.decider.actions.length, 2);
  assert.equal(reported.trades.length, 2);
});

test('runCycle: a thrown error mid-cycle is caught, reported, and returned as CycleResult.error (never rejects)', async () => {
  const { ctx, reported } = baseCtx({
    deps: { agents: { ...fakeAgentsModule(), runAnalystsInParallel: async () => { throw new Error('spawn failed'); } } },
  });
  const result = await runCycle(ctx);
  assert.equal(result.stopped, false);
  assert.match(result.error, /spawn failed/);
  assert.match(reported.blocked[0], /cycle error/);
});

test('runCycle: a recordTrade failure does not stop the rest of the cycle from reporting/saving', async () => {
  const decider = { actions: [{ token: TOKEN, side: 'buy', amountWei: '1', amountOutWei: '1', ok: true, warnings: [] }], reasoning: 'x', skipped: null };
  const { ctx, reported } = baseCtx({
    deps: { agents: fakeAgentsModule({ deciderResult: decider }), ledger: fakeLedgerModule({ recordTradeThrows: true }) },
  });
  const result = await runCycle(ctx);
  assert.equal(result.error, undefined); // recordTrade failures are logged, not treated as a cycle error
  assert.equal(reported.trades.length, 0); // never reported since it was never successfully recorded
});

test('runCycle: passes process.env as mcpServerEnv so the spawned MCP-server subprocess sees real credentials', async () => {
  let analystOpts = null;
  let deciderOpts = null;
  const agents = {
    ...fakeAgentsModule(),
    async runAnalystsInParallel(input, opts) {
      analystOpts = opts;
      return { momentumScout: [], riskAnalyst: [], portfolioManager: [] };
    },
    async runDecider(input, opts) {
      deciderOpts = opts;
      return { actions: [], reasoning: 'x', skipped: 'nothing to do' };
    },
  };
  const { ctx } = baseCtx({ deps: { agents } });
  await runCycle(ctx);
  assert.equal(analystOpts.mcpServerEnv, process.env);
  assert.equal(deciderOpts.mcpServerEnv, process.env);
});

test('runCycle: filters out tokens with a blocked status before they ever reach the analysts', async () => {
  let seenMarket = null;
  const agents = {
    ...fakeAgentsModule(),
    async runAnalystsInParallel(input) {
      seenMarket = input.market;
      return { momentumScout: [], riskAnalyst: [], portfolioManager: [] };
    },
  };
  const tokens = [
    { address: TOKEN, name: 'Ok Token', symbol: 'OK', status: 'active' },
    { address: '0x000000000000000000000000000000000000cc', name: 'Bad', symbol: 'BAD', status: 'rugged' },
  ];
  const { ctx } = baseCtx({ api: fakeApi({ tokens }), deps: { agents } });
  await runCycle(ctx);
  assert.equal(seenMarket.length, 1);
  assert.equal(seenMarket[0].symbol, 'OK');
  assert.equal(seenMarket[0].tradeable, true);
});

test('runCycle: writes status.json with an incrementing cyclesRun across repeated calls', async () => {
  const { ctx, io } = baseCtx();
  await runCycle(ctx);
  await runCycle(ctx);
  const status = JSON.parse(io.files.get('state/status.json'));
  assert.equal(status.cyclesRun, 2);
  assert.equal(status.paperMode, true);
  assert.equal(status.lastError, null);
});

test('runCycle: paper mode derives holdings/portfolio from the ledger, never a live vault read', async () => {
  const ledgerState = {
    version: 1,
    totalDepositedWei: (100n * QUAI).toString(),
    realizedPnlWei: '0',
    gasSpentWei: '0',
    positions: { [TOKEN]: { symbol: 'DOGE2', amountWei: (10n * QUAI).toString(), avgCostQuaiWei: (5n * QUAI).toString() } },
    trades: [],
    deposits: [],
  };
  let seenInput = null;
  const agents = {
    ...fakeAgentsModule(),
    async runDecider(input) {
      seenInput = input;
      return { actions: [], reasoning: 'x', skipped: 'nothing to do' };
    },
  };
  // A real vault fetch that, if it were used, would prove the bug — paper mode must never use it.
  const api = fakeApi({ vault: { paused: false, quaiBalanceWei: (99999n * QUAI).toString(), holdings: [{ token: TOKEN, symbol: 'DOGE2', amountWei: '1', markValueQuaiWei: '1' }] } });
  const { ctx } = baseCtx({ ledgerState, api, deps: { agents } });

  await runCycle(ctx);

  assert.equal(seenInput.portfolio.quaiWei, (100n * QUAI).toString()); // from the ledger, not the fake vault's 99999
  assert.equal(seenInput.holdings.length, 1);
  assert.equal(seenInput.holdings[0].amountWei, (10n * QUAI).toString());
  assert.equal(seenInput.holdings[0].symbol, 'DOGE2');
});

// --- shouldStop ------------------------------------------------------------------------------

test('shouldStop: true on kill switch', async () => {
  const { ctx } = baseCtx({ deps: { guard: fakeGuardModule({ killed: true }) } });
  const result = await shouldStop(ctx);
  assert.deepEqual(result, { stop: true, reason: 'kill-switch' });
});

test('shouldStop: true when the agent EOA gas balance is below the configured floor', async () => {
  const { ctx } = baseCtx({ deps: { chain: fakeChainModule({ gasWei: 1n }) } });
  const result = await shouldStop(ctx);
  assert.equal(result.stop, true);
  assert.equal(result.reason, 'gas-floor');
});

test('shouldStop: true when the vault is paused (live mode)', async () => {
  const { ctx } = baseCtx({
    config: { paperMode: false },
    api: fakeApi({ vault: { paused: true, quaiBalanceWei: (100n * QUAI).toString(), holdings: [] } }),
    deps: { chain: fakeChainModule({ gasWei: 100n * QUAI }) },
  });
  const result = await shouldStop(ctx);
  assert.deepEqual(result, { stop: true, reason: 'vault-paused' });
});

test('shouldStop: true when total vault value is below the capital-exhausted threshold (live mode)', async () => {
  const { ctx } = baseCtx({
    config: { paperMode: false },
    api: fakeApi({ vault: { paused: false, quaiBalanceWei: '1', holdings: [] } }),
    deps: { chain: fakeChainModule({ gasWei: 100n * QUAI }) },
  });
  const result = await shouldStop(ctx);
  assert.deepEqual(result, { stop: true, reason: 'capital-exhausted' });
});

test('shouldStop: false (and never throws) on a healthy vault + gas balance (live mode)', async () => {
  const { ctx } = baseCtx({ config: { paperMode: false }, deps: { chain: fakeChainModule({ gasWei: 100n * QUAI }) } });
  const result = await shouldStop(ctx);
  assert.deepEqual(result, { stop: false });
});

test('shouldStop: a transient vault-read failure never stops a live session on its own', async () => {
  const { ctx } = baseCtx({
    config: { paperMode: false },
    api: fakeApi({ getVaultImpl: async () => { throw new Error('502'); } }),
    deps: { chain: fakeChainModule({ gasWei: 100n * QUAI }) },
  });
  const result = await shouldStop(ctx);
  assert.deepEqual(result, { stop: false });
});

test('shouldStop: paper mode ignores a real vault being paused — nothing paper touches it', async () => {
  const ledgerState = { totalDepositedWei: (10n * QUAI).toString(), gasSpentWei: '0', positions: {}, trades: [] };
  const { ctx } = baseCtx({
    ledgerState,
    api: fakeApi({ vault: { paused: true, quaiBalanceWei: '0', holdings: [] } }),
    deps: { chain: fakeChainModule({ gasWei: 100n * QUAI }) },
  });
  const result = await shouldStop(ctx);
  assert.deepEqual(result, { stop: false });
});

test('shouldStop: paper mode is capital-exhausted when the ledger-derived cash is below threshold', async () => {
  const ledgerState = { totalDepositedWei: '1', gasSpentWei: '0', positions: {}, trades: [] };
  const { ctx } = baseCtx({ ledgerState, deps: { chain: fakeChainModule({ gasWei: 100n * QUAI }) } });
  const result = await shouldStop(ctx);
  assert.deepEqual(result, { stop: true, reason: 'capital-exhausted' });
});

test('shouldStop: paper mode is healthy when the ledger-derived cash is above threshold', async () => {
  const ledgerState = { totalDepositedWei: (100n * QUAI).toString(), gasSpentWei: '0', positions: {}, trades: [] };
  const { ctx } = baseCtx({ ledgerState, deps: { chain: fakeChainModule({ gasWei: 100n * QUAI }) } });
  const result = await shouldStop(ctx);
  assert.deepEqual(result, { stop: false });
});

// --- runLoop -------------------------------------------------------------------------------

test('runLoop: stops on maxCycles and sleeps a jittered pause (in [minIntervalMs, maxIntervalMs]) between cycles', async () => {
  const sleeps = [];
  const { ctx } = baseCtx({ deps: { sleepFn: async (ms) => sleeps.push(ms), randomFn: () => 0.25 } });
  await runLoop(ctx, { maxCycles: 3 });
  assert.equal(sleeps.length, 2); // no trailing sleep after the last cycle
  for (const ms of sleeps) {
    assert.ok(ms >= DEFAULT_PAUSE_MIN_MS && ms <= DEFAULT_PAUSE_MAX_MS, `pause ${ms}ms out of [${DEFAULT_PAUSE_MIN_MS}, ${DEFAULT_PAUSE_MAX_MS}]`);
  }
});

test('runLoop: an explicit intervalMs disables jitter and is used as-is', async () => {
  const sleeps = [];
  const { ctx } = baseCtx({ deps: { sleepFn: async (ms) => sleeps.push(ms) } });
  await runLoop(ctx, { maxCycles: 2, intervalMs: 42 });
  assert.deepEqual(sleeps, [42]);
});

test('runLoop: stops immediately (no sleep) when a cycle itself reports stopped:true', async () => {
  const sleeps = [];
  const { ctx } = baseCtx({ deps: { guard: fakeGuardModule({ killed: true }), sleepFn: async (ms) => sleeps.push(ms) } });
  await runLoop(ctx, { maxCycles: 5 });
  assert.deepEqual(sleeps, []);
});

test('runLoop: stops after maxConsecutiveFailures and reports why', async () => {
  const failingAgents = { ...fakeAgentsModule(), runAnalystsInParallel: async () => { throw new Error('down'); } };
  const { ctx, reported } = baseCtx({ deps: { agents: failingAgents, sleepFn: async () => {} } });
  await runLoop(ctx, { maxCycles: 10, maxConsecutiveFailures: 2 });
  assert.equal(reported.blocked.some((r) => /consecutive/.test(r)), true);
});

test('runLoop: a successful cycle resets the consecutive-failure counter', async () => {
  let call = 0;
  const flaky = {
    ...fakeAgentsModule(),
    async runAnalystsInParallel() {
      call += 1;
      if (call === 1) throw new Error('one-off blip');
      return { momentumScout: [], riskAnalyst: [], portfolioManager: [] };
    },
  };
  const { ctx, reported } = baseCtx({ deps: { agents: flaky, sleepFn: async () => {} } });
  await runLoop(ctx, { maxCycles: 4, maxConsecutiveFailures: 2 });
  // 1 failure then 3 successes never reaches 2 CONSECUTIVE failures, so the loop must run all 4
  // cycles and never emit a "consecutive failures" stop notice.
  assert.equal(call, 4);
  assert.equal(reported.blocked.some((r) => /consecutive/.test(r)), false);
});

test('runLoop: stops when the max session duration elapses', async () => {
  let clock = 0;
  const { ctx, reported } = baseCtx({ deps: { now: () => clock, sleepFn: async (ms) => { clock += ms; } } });
  await runLoop(ctx, { maxCycles: 100, maxSessionMs: 1000, minIntervalMs: 10_000, maxIntervalMs: 10_000 });
  assert.ok(reported.blocked.some((r) => /max session/.test(r)));
});

// --- writeStatus / readStatus ------------------------------------------------------------------

test('writeStatus + readStatus round-trip through injected impls', async () => {
  const io = memoryStatusIO();
  const status = { lastCycleAtMs: 1, cyclesRun: 1, paperMode: true, portfolio: { quaiWei: '1', totalValueWei: '1' }, realizedPnlWei: '0', growthPct: 0, lastError: null };
  await writeStatus('state/status.json', status, io.writeStatusImpl);
  const readBack = await readStatus('state/status.json', io.readStatusImpl);
  assert.deepEqual(readBack, status);
});

test('readStatus returns null when the file does not exist yet', async () => {
  const io = memoryStatusIO();
  const result = await readStatus('state/status.json', io.readStatusImpl);
  assert.equal(result, null);
});

test('readStatus returns null (never throws) on malformed JSON', async () => {
  const readImpl = async () => 'not json{{{';
  const result = await readStatus('state/status.json', readImpl);
  assert.equal(result, null);
});
