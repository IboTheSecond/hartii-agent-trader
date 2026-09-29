import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as chain from '../src/chain/index.mjs';

// Placeholder scaffold test — replace with real coverage (fake provider/wallet, no network)
// once src/chain is implemented. Every get*/send* export must accept its provider/wallet as a
// parameter — never reach the real network in a unit test.

test('chain: known public contract addresses are exported', () => {
  assert.equal(chain.TOKEN_FACTORY_V1_ADDRESS, '0x001AF1BbB40807fcb99C9Eeaa49dF5E91e7Efd42');
  assert.match(chain.WQUAI_ADDRESS, /^0x00/);
});

test('chain: checksum is a stub — throws not implemented until built', () => {
  assert.throws(() => chain.checksum('0x00abc'), /not implemented/);
});

test('chain: buildVaultExecuteCalldata is a stub — throws not implemented until built', () => {
  assert.throws(
    () => chain.buildVaultExecuteCalldata('0x00vault', { to: '0x00target', value: 0n, data: '0x' }),
    /not implemented/,
  );
});

test('chain: sendVaultExecute is a stub — throws not implemented until built', async () => {
  await assert.rejects(
    () => chain.sendVaultExecute({}, '0x00vault', { to: '0x00target', value: 0n, data: '0x' }),
    /not implemented/,
  );
});
