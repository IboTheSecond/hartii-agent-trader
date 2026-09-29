import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, getAgentKeyMaterial, getProfile, PROFILES, DEFAULTS, ConfigError } from '../src/config/index.mjs';

const VALID_KEY = `0x${'a1'.repeat(32)}`;
const VALID_VAULT = '0x006c2be96d6ca90d0105a2bfa7ac2187f40e899d'; // lowercase in — loadConfig must checksum it

// State paths are resolved to absolute, anchored at the repo root — never left relative to
// whatever process.cwd() happens to be (see src/config's own header comment on why: a spawned
// analyst/decider session's sandboxed cwd is never this repo). REPO_ROOT here is computed the
// same independent way (from this file's own location, one level up from test/), so these
// assertions don't just assume node --test happens to be invoked from the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function expectedStatePath(...segments) {
  return path.resolve(REPO_ROOT, ...segments);
}

function baseEnv(overrides = {}) {
  return { ...overrides };
}

test('config: constants are present and frozen (contract shape)', () => {
  assert.ok(PROFILES.reckless);
  assert.ok(PROFILES.balanced);
  assert.equal(Object.isFrozen(PROFILES), true);
  assert.equal(typeof DEFAULTS.apiBase, 'string');
});

test('config: getProfile throws on unknown name', () => {
  assert.throws(() => getProfile('not-a-profile'));
});

test('config: loadConfig({}) defaults to paper mode with no vault/key required', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.paperMode, true);
  assert.equal(config.hasAgentKey, false);
  assert.equal(config.vaultAddress, null);
  assert.equal(config.profile, 'reckless');
  assert.equal(config.dryRun, false);
  assert.equal(config.launchesEnabled, false);
  assert.equal(config.telegram, null);
  assert.equal(config.ntfyUrl, null);
  assert.equal(config.apiBase, DEFAULTS.apiBase);
  assert.equal(config.rpcUrl, DEFAULTS.rpcUrl);
  assert.equal(config.chainId, DEFAULTS.chainId);
  assert.equal(config.maxActionsPerCycle, DEFAULTS.maxActionsPerCycle);
  assert.equal(config.cycleIntervalMs, DEFAULTS.cycleIntervalMs);
  assert.equal(config.killSwitchFile, expectedStatePath('state', 'STOP'));
  assert.equal(config.statusFile, expectedStatePath('state', 'status.json'));
  assert.equal(config.ledgerFile, expectedStatePath('state', 'ledger.json'));
  assert.equal(config.memoryFile, expectedStatePath('state', 'memory.json'));
  assert.ok(path.isAbsolute(config.ledgerFile), 'state paths must be absolute — never resolved against a caller-specific cwd');
});

test('config: is frozen and never exposes the key material as an enumerable/own string field', () => {
  const config = loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_AGENT_KEY: VALID_KEY }));
  assert.equal(Object.isFrozen(config), true);
  assert.throws(() => {
    config.paperMode = false;
  });
  const json = JSON.stringify(config);
  assert.equal(json.includes(VALID_KEY.slice(2)), false);
  for (const k of Object.keys(config)) {
    assert.notEqual(typeof config[k] === 'string' && config[k] === VALID_KEY, true);
  }
});

test('config: HARTII_PAPER=1 forces paper mode even with a well-formed key present', () => {
  const config = loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_AGENT_KEY: VALID_KEY }));
  assert.equal(config.paperMode, true);
  assert.equal(config.hasAgentKey, true);
  assert.throws(() => getAgentKeyMaterial(config), /paperMode is true/);
});

test('config: a well-formed key with no HARTII_PAPER resolves to live mode and requires HARTII_VAULT_ADDRESS', () => {
  assert.throws(() => loadConfig(baseEnv({ HARTII_AGENT_KEY: VALID_KEY })), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.deepEqual(err.missing, ['HARTII_VAULT_ADDRESS']);
    return true;
  });
});

test('config: live mode with key + vault resolves paperMode false and getAgentKeyMaterial returns the key', () => {
  const config = loadConfig(baseEnv({ HARTII_AGENT_KEY: VALID_KEY, HARTII_VAULT_ADDRESS: VALID_VAULT }));
  assert.equal(config.paperMode, false);
  assert.equal(config.hasAgentKey, true);
  assert.equal(getAgentKeyMaterial(config), VALID_KEY);
});

test('config: HARTII_VAULT_ADDRESS is checksummed on load regardless of input case', () => {
  const config = loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_VAULT_ADDRESS: VALID_VAULT }));
  assert.notEqual(config.vaultAddress, VALID_VAULT); // checksummed form differs from the all-lowercase input
  assert.equal(config.vaultAddress.toLowerCase(), VALID_VAULT.toLowerCase());
});

test('config: an invalid HARTII_VAULT_ADDRESS is reported in ConfigError.invalid', () => {
  assert.throws(() => loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_VAULT_ADDRESS: 'not-an-address' })), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.invalid.some((i) => i.field === 'HARTII_VAULT_ADDRESS'));
    return true;
  });
});

test('config: HARTII_AGENT_KEY and HARTII_AGENT_KEY_FILE together is invalid (mutually exclusive)', () => {
  assert.throws(() => loadConfig(baseEnv({ HARTII_AGENT_KEY: VALID_KEY, HARTII_AGENT_KEY_FILE: '/tmp/whatever', HARTII_VAULT_ADDRESS: VALID_VAULT })), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.invalid.some((i) => i.field === 'HARTII_AGENT_KEY'));
    return true;
  });
});

test('config: a malformed HARTII_AGENT_KEY is invalid, never silently accepted', () => {
  assert.throws(() => loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_AGENT_KEY: '0xnothex' })), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.invalid.some((i) => i.field === 'HARTII_AGENT_KEY'));
    return true;
  });
});

test('config: HARTII_AGENT_KEY_FILE reads and trims a real file, and getAgentKeyMaterial returns its contents', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hartii-config-test-'));
  const keyFile = path.join(dir, 'agent.key');
  try {
    writeFileSync(keyFile, `${VALID_KEY}\n`, 'utf8');
    const config = loadConfig(baseEnv({ HARTII_AGENT_KEY_FILE: keyFile, HARTII_VAULT_ADDRESS: VALID_VAULT }));
    assert.equal(config.paperMode, false);
    assert.equal(config.hasAgentKey, true);
    assert.equal(getAgentKeyMaterial(config), VALID_KEY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: a missing HARTII_AGENT_KEY_FILE is invalid, not a thrown fs error', () => {
  assert.throws(() => loadConfig(baseEnv({ HARTII_AGENT_KEY_FILE: path.join(os.tmpdir(), 'does-not-exist-hartii.key'), HARTII_VAULT_ADDRESS: VALID_VAULT })), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.invalid.some((i) => i.field === 'HARTII_AGENT_KEY_FILE'));
    return true;
  });
});

test('config: an unknown HARTII_PROFILE is invalid', () => {
  assert.throws(() => loadConfig(baseEnv({ HARTII_PROFILE: 'yolo' })), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.invalid.some((i) => i.field === 'HARTII_PROFILE'));
    return true;
  });
});

test('config: collects multiple invalid/missing fields into one ConfigError rather than throwing on the first', () => {
  assert.throws(() => loadConfig(baseEnv({ HARTII_AGENT_KEY: 'bad', HARTII_PROFILE: 'nope', HARTII_MAX_ACTIONS_PER_CYCLE: '-1' })), (err) => {
    assert.ok(err instanceof ConfigError);
    const fields = err.invalid.map((i) => i.field);
    assert.ok(fields.includes('HARTII_AGENT_KEY'));
    assert.ok(fields.includes('HARTII_PROFILE'));
    assert.ok(fields.includes('HARTII_MAX_ACTIONS_PER_CYCLE'));
    return true;
  });
});

test('config: non-integer/zero/negative numeric overrides are invalid', () => {
  for (const bad of ['0', '-5', 'abc', '1.5']) {
    assert.throws(() => loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_CYCLE_INTERVAL_MS: bad })), ConfigError, `expected ${bad} to be invalid`);
  }
});

test('config: HARTII_MAX_PRICE_IMPACT_PCT overrides only when set, and is invalid when non-numeric', () => {
  const unset = loadConfig(baseEnv({ HARTII_PAPER: '1' }));
  assert.equal('maxPriceImpactPct' in unset, false);

  const overridden = loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_MAX_PRICE_IMPACT_PCT: '12.5' }));
  assert.equal(overridden.maxPriceImpactPct, 12.5);

  assert.throws(() => loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_MAX_PRICE_IMPACT_PCT: 'lots' })), ConfigError);
});

test('config: TELEGRAM_* both set builds config.telegram; either alone leaves it null', () => {
  const both = loadConfig(baseEnv({ HARTII_PAPER: '1', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' }));
  assert.deepEqual(both.telegram, { botToken: 'tok', chatId: 'chat' });

  const onlyToken = loadConfig(baseEnv({ HARTII_PAPER: '1', TELEGRAM_BOT_TOKEN: 'tok' }));
  assert.equal(onlyToken.telegram, null);
});

test('config: HARTII_STATE_DIR relocates status/ledger/memory files together (still resolved absolute, anchored at the repo root)', () => {
  const config = loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_STATE_DIR: 'custom-state/' }));
  assert.equal(config.statusFile, expectedStatePath('custom-state', 'status.json'));
  assert.equal(config.ledgerFile, expectedStatePath('custom-state', 'ledger.json'));
  assert.equal(config.memoryFile, expectedStatePath('custom-state', 'memory.json'));
  assert.equal(config.killSwitchFile, expectedStatePath('custom-state', 'STOP'));
});

test('config: HARTII_KILL_SWITCH_FILE overrides the state-dir-derived default explicitly (also resolved absolute)', () => {
  const config = loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_STATE_DIR: 'custom-state/', HARTII_KILL_SWITCH_FILE: 'elsewhere/STOP' }));
  assert.equal(config.killSwitchFile, expectedStatePath('elsewhere', 'STOP'));
});

test('config: an already-absolute HARTII_STATE_DIR/HARTII_KILL_SWITCH_FILE is used as-is, not re-anchored', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hartii-config-state-'));
  try {
    const config = loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_STATE_DIR: dir }));
    assert.equal(config.ledgerFile, path.join(dir, 'ledger.json'));

    const explicitKillSwitch = path.join(dir, 'MY-STOP');
    const config2 = loadConfig(baseEnv({ HARTII_PAPER: '1', HARTII_KILL_SWITCH_FILE: explicitKillSwitch }));
    assert.equal(config2.killSwitchFile, explicitKillSwitch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: getAgentKeyMaterial on a plain object (not produced by loadConfig) throws cleanly', () => {
  assert.throws(() => getAgentKeyMaterial({ paperMode: false }), /no agent key is configured/);
});

test('ConfigError carries structured missing/invalid arrays', () => {
  const err = new ConfigError({ missing: ['A'], invalid: [{ field: 'B', reason: 'bad' }] });
  assert.deepEqual(err.missing, ['A']);
  assert.deepEqual(err.invalid, [{ field: 'B', reason: 'bad' }]);
  assert.equal(err.name, 'ConfigError');
});
