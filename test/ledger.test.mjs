import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ledger from '../src/ledger/index.mjs';

// Placeholder scaffold test — replace with real coverage (average-cost realized/unrealized
// PnL, deposits tracked separately from PnL, gas accounting) once src/ledger is implemented.

test('ledger: LEDGER_SCHEMA_VERSION is pinned', () => {
  assert.equal(ledger.LEDGER_SCHEMA_VERSION, 1);
});

test('ledger: createLedger is a stub — throws not implemented until built', () => {
  assert.throws(() => ledger.createLedger(), /not implemented/);
});

test('ledger: recordTrade is a stub — throws not implemented until built', () => {
  assert.throws(() => ledger.recordTrade({}, { side: 'buy' }), /not implemented/);
});

test('ledger: loadLedger/saveLedger are stubs — throw not implemented until built (no fs)', async () => {
  await assert.rejects(() => ledger.loadLedger('state/ledger.json', async () => '{}'), /not implemented/);
  await assert.rejects(() => ledger.saveLedger('state/ledger.json', {}, async () => {}), /not implemented/);
});
