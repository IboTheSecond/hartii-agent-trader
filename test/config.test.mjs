import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, getAgentKeyMaterial, getProfile, PROFILES, DEFAULTS } from '../src/config/index.mjs';

// Placeholder scaffold test — replace with real coverage once src/config is implemented.
// No network: loadConfig must only ever read the env object it's given.

test('config: constants are present and frozen (contract shape)', () => {
  assert.ok(PROFILES.reckless);
  assert.ok(PROFILES.balanced);
  assert.equal(Object.isFrozen(PROFILES), true);
  assert.equal(typeof DEFAULTS.apiBase, 'string');
});

test('config: getProfile throws on unknown name', () => {
  assert.throws(() => getProfile('not-a-profile'));
});

test('config: loadConfig is a stub — throws not implemented until built', () => {
  assert.throws(() => loadConfig({}), /not implemented/);
});

test('config: getAgentKeyMaterial is a stub — throws not implemented until built', () => {
  assert.throws(() => getAgentKeyMaterial({ paperMode: true }), /not implemented/);
});
