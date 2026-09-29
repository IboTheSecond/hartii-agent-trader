import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ledger from '../src/ledger/index.mjs';

// No fs in unit tests: loadLedger/saveLedger always take an injected readImpl/writeImpl below.

const TOKEN_A = '0x00AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = '0x00BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function buyTrade(overrides = {}) {
  return {
    id: 't1',
    atMs: 1,
    side: 'buy',
    token: TOKEN_A,
    symbol: 'FOO',
    amountQuaiWei: '100',
    amountTokenWei: '1000000000000000000', // 1 whole token
    priceQuaiPerTokenWei: '100',
    txHash: '0xabc',
    gasWei: '5',
    reason: 'test buy',
    paper: true,
    ...overrides,
  };
}

function sellTrade(overrides = {}) {
  return {
    id: 't2',
    atMs: 2,
    side: 'sell',
    token: TOKEN_A,
    symbol: 'FOO',
    amountQuaiWei: '60',
    amountTokenWei: '500000000000000000', // 0.5 whole token
    priceQuaiPerTokenWei: '120',
    txHash: '0xdef',
    gasWei: '3',
    reason: 'test sell',
    paper: true,
    ...overrides,
  };
}

test('ledger: LEDGER_SCHEMA_VERSION is pinned', () => {
  assert.equal(ledger.LEDGER_SCHEMA_VERSION, 1);
});

test('ledger: createLedger returns an empty, JSON-safe ledger matching the schema', () => {
  const empty = ledger.createLedger();
  assert.equal(empty.version, 1);
  assert.equal(empty.totalDepositedWei, '0');
  assert.equal(empty.realizedPnlWei, '0');
  assert.equal(empty.gasSpentWei, '0');
  assert.deepEqual(empty.positions, {});
  assert.deepEqual(empty.trades, []);
  assert.deepEqual(empty.deposits, []);
  // never throws — every field is JSON-primitive (no bigint anywhere in the ledger document)
  assert.doesNotThrow(() => JSON.stringify(empty));
});

// --- recordDeposit -----------------------------------------------------------------------------

test('ledger: recordDeposit accumulates totalDepositedWei and appends a deposit record', () => {
  let l = ledger.createLedger();
  l = ledger.recordDeposit(l, { amountWei: 1000n, atMs: 1, txHash: '0x1' });
  l = ledger.recordDeposit(l, { amountWei: 500n, atMs: 2 });
  assert.equal(l.totalDepositedWei, '1500');
  assert.equal(l.deposits.length, 2);
  assert.equal(l.deposits[0].amountWei, '1000');
  assert.equal(l.deposits[1].txHash, null);
});

// --- recordTrade: average cost -------------------------------------------------------------

test('ledger: recordTrade(buy) opens a new position at the trade price', () => {
  const l = ledger.recordTrade(ledger.createLedger(), buyTrade());
  const pos = l.positions[TOKEN_A];
  assert.equal(pos.amountWei, '1000000000000000000');
  // avgCostQuaiWei is QUAI-wei per 1e18 token-wei: 100 QUAI wei paid for 1e18 token-wei = 100
  assert.equal(pos.avgCostQuaiWei, '100');
  assert.equal(ledger.getRealizedPnlWei(l), 0n);
});

test('ledger: recordTrade(buy) averages cost across two buys at different prices', () => {
  let l = ledger.createLedger();
  l = ledger.recordTrade(l, buyTrade({ id: 'b1', amountQuaiWei: '100', amountTokenWei: '1000000000000000000' })); // price 100
  l = ledger.recordTrade(l, buyTrade({ id: 'b2', amountQuaiWei: '300', amountTokenWei: '1000000000000000000' })); // price 300
  const pos = l.positions[TOKEN_A];
  assert.equal(pos.amountWei, '2000000000000000000');
  // (100 + 300) QUAI for 2e18 token-wei -> avg cost 200 per 1e18
  assert.equal(pos.avgCostQuaiWei, '200');
});

test('ledger: recordTrade(sell) realizes PnL against average cost and shrinks the position', () => {
  let l = ledger.createLedger();
  l = ledger.recordTrade(l, buyTrade()); // 1 token @ cost 100
  l = ledger.recordTrade(l, sellTrade()); // sell 0.5 token for 60 QUAI; cost basis for that half = 50
  assert.equal(ledger.getRealizedPnlWei(l), 10n); // 60 - 50
  const pos = l.positions[TOKEN_A];
  assert.equal(pos.amountWei, '500000000000000000');
  assert.equal(pos.avgCostQuaiWei, '100'); // remaining position's avg cost is unchanged by a sell
});

test('ledger: recordTrade(sell) that fully closes a position removes it from `positions`', () => {
  let l = ledger.createLedger();
  l = ledger.recordTrade(l, buyTrade({ amountTokenWei: '500000000000000000' })); // 0.5 token
  l = ledger.recordTrade(l, sellTrade({ amountTokenWei: '500000000000000000' })); // sell all of it
  assert.equal(Object.prototype.hasOwnProperty.call(l.positions, TOKEN_A), false);
});

test('ledger: recordTrade throws when selling more than the tracked position', () => {
  const l = ledger.recordTrade(ledger.createLedger(), buyTrade({ amountTokenWei: '100' }));
  assert.throws(() => ledger.recordTrade(l, sellTrade({ amountTokenWei: '999999999999999999999' })), /cannot sell/);
});

test('ledger: recordTrade folds trade.gasWei into the running gasSpentWei total', () => {
  let l = ledger.createLedger();
  l = ledger.recordTrade(l, buyTrade({ gasWei: '5' }));
  l = ledger.recordTrade(l, sellTrade({ gasWei: '3', amountTokenWei: '100000000000000000' }));
  assert.equal(l.gasSpentWei, '8');
});

test('ledger: recordTrade appends to the trades array (append-only, newest last)', () => {
  let l = ledger.createLedger();
  l = ledger.recordTrade(l, buyTrade({ id: 'a' }));
  l = ledger.recordTrade(l, sellTrade({ id: 'b', amountTokenWei: '100000000000000000' }));
  assert.deepEqual(l.trades.map((t) => t.id), ['a', 'b']);
});

// --- recordGas -----------------------------------------------------------------------------

test('ledger: recordGas accumulates gasSpentWei independently of trades', () => {
  let l = ledger.createLedger();
  l = ledger.recordGas(l, { gasWei: 10n, atMs: 1, txHash: '0x1' });
  l = ledger.recordGas(l, { gasWei: 5n, atMs: 2, txHash: '0x2' });
  assert.equal(l.gasSpentWei, '15');
});

// --- getUnrealizedPnlWei ---------------------------------------------------------------------

test('ledger: getUnrealizedPnlWei computes mark value minus cost basis for a held position', () => {
  const l = ledger.recordTrade(ledger.createLedger(), buyTrade()); // 1 token @ avgCost 100
  // mark price 150 per 1e18 token-wei -> mark value 150, cost value 100 -> unrealized +50
  const unrealized = ledger.getUnrealizedPnlWei(l, { [TOKEN_A]: 150n });
  assert.equal(unrealized, 50n);
});

test('ledger: getUnrealizedPnlWei skips positions with no live mark rather than guessing', () => {
  const l = ledger.recordTrade(ledger.createLedger(), buyTrade());
  assert.equal(ledger.getUnrealizedPnlWei(l, {}), 0n);
  assert.equal(ledger.getUnrealizedPnlWei(l), 0n);
});

test('ledger: getUnrealizedPnlWei can be negative when the mark is below cost', () => {
  const l = ledger.recordTrade(ledger.createLedger(), buyTrade()); // avgCost 100
  assert.equal(ledger.getUnrealizedPnlWei(l, { [TOKEN_A]: 40n }), -60n);
});

// --- getGrowthPct -----------------------------------------------------------------------------

test('ledger: getGrowthPct is 0 when nothing has been deposited (avoids divide-by-zero)', () => {
  assert.equal(ledger.getGrowthPct(ledger.createLedger(), 5000n), 0);
});

test('ledger: getGrowthPct computes percentage growth vs total deposits, not trading volume', () => {
  const l = ledger.recordDeposit(ledger.createLedger(), { amountWei: 1000n, atMs: 1 });
  assert.equal(ledger.getGrowthPct(l, 1200n), 20);
  assert.equal(ledger.getGrowthPct(l, 800n), -20);
  assert.equal(ledger.getGrowthPct(l, 1000n), 0);
});

test('ledger: getGrowthPct is unaffected by a top-up beyond its effect on totalDepositedWei (deposits never counted as profit)', () => {
  let l = ledger.recordDeposit(ledger.createLedger(), { amountWei: 1000n, atMs: 1 });
  // a pure top-up: portfolio value rises by exactly the deposit amount -> 0% growth, not +100%
  l = ledger.recordDeposit(l, { amountWei: 1000n, atMs: 2 });
  assert.equal(ledger.getGrowthPct(l, 2000n), 0);
});

// --- getRecentTrades --------------------------------------------------------------------------

test('ledger: getRecentTrades returns the last n trades, most-recent-first', () => {
  let l = ledger.createLedger();
  for (const id of ['a', 'b', 'c', 'd']) {
    l = ledger.recordTrade(l, buyTrade({ id, token: TOKEN_B, amountTokenWei: '1' }));
  }
  const recent = ledger.getRecentTrades(l, 2);
  assert.deepEqual(recent.map((t) => t.id), ['d', 'c']);
});

test('ledger: getRecentTrades defaults n to 5', () => {
  let l = ledger.createLedger();
  for (let i = 0; i < 7; i += 1) {
    l = ledger.recordTrade(l, buyTrade({ id: `t${i}`, token: TOKEN_B, amountTokenWei: '1' }));
  }
  assert.equal(ledger.getRecentTrades(l).length, 5);
});

// --- loadLedger / saveLedger (fs injected, no real disk I/O) --------------------------------

test('ledger: loadLedger returns an empty ledger when the file does not exist (ENOENT)', async () => {
  const readImpl = async () => {
    const err = new Error('not found');
    err.code = 'ENOENT';
    throw err;
  };
  const loaded = await ledger.loadLedger('state/ledger.json', readImpl);
  assert.deepEqual(loaded, ledger.createLedger());
});

test('ledger: loadLedger parses and normalizes an existing file', async () => {
  const saved = ledger.recordDeposit(ledger.createLedger(), { amountWei: 42n, atMs: 1 });
  const readImpl = async () => JSON.stringify(saved);
  const loaded = await ledger.loadLedger('state/ledger.json', readImpl);
  assert.equal(loaded.totalDepositedWei, '42');
});

test('ledger: loadLedger propagates a non-ENOENT read failure rather than silently discarding data', async () => {
  const readImpl = async () => {
    throw new Error('disk on fire');
  };
  await assert.rejects(() => ledger.loadLedger('state/ledger.json', readImpl), /disk on fire/);
});

test('ledger: saveLedger serializes the ledger via the injected writeImpl', async () => {
  let seenPath;
  let seenContents;
  const writeImpl = async (filePath, contents) => {
    seenPath = filePath;
    seenContents = contents;
  };
  const l = ledger.recordDeposit(ledger.createLedger(), { amountWei: 7n, atMs: 1 });
  await ledger.saveLedger('state/ledger.json', l, writeImpl);
  assert.equal(seenPath, 'state/ledger.json');
  assert.deepEqual(JSON.parse(seenContents), l);
});

test('ledger: save then load round-trips a ledger exactly', async () => {
  let store = null;
  const writeImpl = async (_filePath, contents) => {
    store = contents;
  };
  const readImpl = async () => {
    if (store === null) {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    }
    return store;
  };
  let l = ledger.createLedger();
  l = ledger.recordDeposit(l, { amountWei: 1000n, atMs: 1 });
  l = ledger.recordTrade(l, buyTrade());
  await ledger.saveLedger('state/ledger.json', l, writeImpl);
  const loaded = await ledger.loadLedger('state/ledger.json', readImpl);
  assert.deepEqual(loaded, l);
});
