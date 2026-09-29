import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, sanitizeTokenText, ApiError } from '../src/data/index.mjs';

// Placeholder scaffold test — replace with real coverage once src/data is implemented. Every
// test must inject a fake fetchImpl; never call the real hartiilabs.com from `node --test`.

async function neverCalledFetch() {
  throw new Error('unit test tried to reach the network — inject fetchImpl instead');
}

test('data: ApiError carries status and body', () => {
  const err = new ApiError('boom', 500, { detail: 'x' });
  assert.equal(err.status, 500);
  assert.deepEqual(err.body, { detail: 'x' });
});

test('data: sanitizeTokenText is a stub — throws not implemented until built', () => {
  assert.throws(() => sanitizeTokenText({ name: 'x', description: 'y' }), /not implemented/);
});

test('data: createApiClient methods are stubs — throw not implemented until built (no network)', async () => {
  const api = createApiClient({ fetchImpl: neverCalledFetch });
  await assert.rejects(() => api.getTokens(), /not implemented/);
  await assert.rejects(() => api.getVault('0x00vault'), /not implemented/);
});
