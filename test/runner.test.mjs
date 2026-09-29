import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCycle, runLoop, shouldStop, writeStatus, readStatus } from '../src/runner/index.mjs';

// Placeholder scaffold test — replace with real coverage once src/runner is implemented.
// Every test must inject fake api/provider/wallet/reporter deps via RunnerCtx; this module
// must never let paper mode reach src/chain's sending functions.

test('runner: runCycle is a stub — throws not implemented until built', async () => {
  await assert.rejects(() => runCycle({}), /not implemented/);
});

test('runner: shouldStop is a stub — throws not implemented until built', async () => {
  await assert.rejects(() => shouldStop({}), /not implemented/);
});

test('runner: writeStatus/readStatus are stubs — throw not implemented until built (no fs)', async () => {
  await assert.rejects(() => writeStatus('state/status.json', {}, async () => {}), /not implemented/);
  await assert.rejects(() => readStatus('state/status.json', async () => null), /not implemented/);
});
