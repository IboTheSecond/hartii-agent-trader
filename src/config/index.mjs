// src/config — env loading/validation, risk profiles, constants.
// Contract: see INTERFACES.md#src-config. Depends on nothing else in src/.
//
// Key material never touches an enumerable/JSON-serializable field (INTERFACES.md's own "no
// secrets logged" rule): loadConfig stores a zero-arg resolver function on the returned Config
// under a module-private Symbol, non-enumerable, defined before the object is frozen.
// getAgentKeyMaterial(config) is the only way to call it, and refuses outright when
// config.paperMode is true — paper mode must never need a key, even if one happens to be
// configured (e.g. HARTII_PAPER=1 forcing paper mode with a real key still present in env).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'quais';

const KEY_MATERIAL = Symbol('hartii-agent-key-material');

// A raw Quai/EVM private key: 0x + 64 hex chars (32 bytes). Applies equally to HARTII_AGENT_KEY
// and the trimmed contents of the file HARTII_AGENT_KEY_FILE points at.
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

const DEFAULT_STATE_DIR = 'state/';

// A relative state path (the default, and HARTII_STATE_DIR/HARTII_KILL_SWITCH_FILE's usual
// values) is resolved against THIS repo's own root, never against process.cwd() — a relative
// path resolved against cwd would break the moment anything reads/writes it from a different
// working directory than whoever set the env var expected, which is exactly what happens for
// every real run of this harness: src/agents spawns each sandboxed analyst/decider `claude -p`
// session with cwd set to a fresh, empty, per-invocation sandbox directory (see
// src/agents#createSandbox) and bin/mcp-server.mjs (running inside that sandboxed session as the
// MCP server subprocess) calls this same loadConfig again from there — so a relative ledgerFile
// would have silently pointed the runner's own seeded ledger.json and the subprocess's
// independently-loaded one at two different, unrelated locations, each process seeing an
// incomplete picture of the same session's real state (confirmed live: the runner's seeded 1000
// QUAI paper deposit was invisible to the decider's own hartii_status call before this fix).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveStatePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

/** @typedef {import('./types.js').Config} Config */
/** @typedef {import('./types.js').Profile} Profile */

export class ConfigError extends Error {
  /**
   * @param {{ missing?: string[], invalid?: { field: string, reason: string }[] }} details
   */
  constructor(details) {
    super('invalid or incomplete configuration — see .missing / .invalid');
    this.name = 'ConfigError';
    this.missing = details.missing || [];
    this.invalid = details.invalid || [];
  }
}

export const DEFAULTS = Object.freeze({
  apiBase: 'https://hartiilabs.com',
  rpcUrl: 'https://rpc.quai.network/cyprus1',
  chainId: 9,
  cycleIntervalMs: 300000,
  maxActionsPerCycle: 3,
  maxFractionOfPortfolioBps: 4000, // 40%
  minGasMultiple: 5,
  maxPriceImpactPctReckless: 8,
  maxPriceImpactPctBalanced: 4,
  launchesEnabled: false,
  nftDeploysEnabled: false, // never overridable — see src/guard#blockNftDeploys
});

/** @type {{ reckless: Profile, balanced: Profile }} */
export const PROFILES = Object.freeze({
  reckless: Object.freeze({
    name: 'reckless',
    actEveryCycle: true,
    sizeFractionBpsRange: [2000, 4000],
    maxPriceImpactPct: DEFAULTS.maxPriceImpactPctReckless,
    trailingExits: true,
    rotateStalledAfterCycles: 2,
    minReserveFractionBps: 3300,
  }),
  balanced: Object.freeze({
    name: 'balanced',
    actEveryCycle: false,
    sizeFractionBpsRange: [500, 1500],
    maxPriceImpactPct: DEFAULTS.maxPriceImpactPctBalanced,
    trailingExits: true,
    rotateStalledAfterCycles: 4,
    minReserveFractionBps: 5000,
  }),
});

/**
 * @param {string} name
 * @returns {Profile}
 */
export function getProfile(name) {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`unknown profile "${name}"`);
  return profile;
}

function boolFlag(env, name) {
  return env[name] === '1';
}

function trimmedOrEmpty(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @returns {number | null} parsed value, DEFAULT when unset/empty, or null to signal "invalid". */
function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** @returns {number | null | undefined} undefined when unset, the number when valid, null when invalid. */
function parseOptionalFiniteNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Loads and validates runtime configuration from environment variables. Never returns a
 * partially-valid Config — either throws ConfigError or returns a fully valid one.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const missing = [];
  const invalid = [];

  // --- agent key (raw XOR file), and whether one is configured at all -------------------------
  const rawKey = trimmedOrEmpty(env.HARTII_AGENT_KEY);
  const rawKeyFile = trimmedOrEmpty(env.HARTII_AGENT_KEY_FILE);
  if (rawKey && rawKeyFile) {
    invalid.push({
      field: 'HARTII_AGENT_KEY',
      reason: 'HARTII_AGENT_KEY and HARTII_AGENT_KEY_FILE are mutually exclusive — set only one',
    });
  }

  let resolveKey = null;
  if (rawKey) {
    if (!PRIVATE_KEY_RE.test(rawKey)) {
      invalid.push({ field: 'HARTII_AGENT_KEY', reason: 'must be a 0x-prefixed 64-hex-character private key' });
    } else {
      resolveKey = () => rawKey;
    }
  } else if (rawKeyFile) {
    try {
      const fileKey = readFileSync(rawKeyFile, 'utf8').trim();
      if (!PRIVATE_KEY_RE.test(fileKey)) {
        invalid.push({
          field: 'HARTII_AGENT_KEY_FILE',
          reason: 'file does not contain a 0x-prefixed 64-hex-character private key',
        });
      } else {
        resolveKey = () => fileKey;
      }
    } catch (err) {
      invalid.push({ field: 'HARTII_AGENT_KEY_FILE', reason: `could not read key file: ${err?.message || err}` });
    }
  }

  // paperMode: true unless a real, well-formed key resolved to something usable AND HARTII_PAPER
  // was not forced — HARTII_PAPER=1 always wins, even over a present key (see env table).
  const paperMode = boolFlag(env, 'HARTII_PAPER') || !resolveKey;
  const dryRun = boolFlag(env, 'HARTII_DRY_RUN');
  const launchesEnabled = boolFlag(env, 'HARTII_LAUNCHES_ENABLED');

  // --- profile ----------------------------------------------------------------------------------
  const profileName = env.HARTII_PROFILE || 'reckless';
  try {
    getProfile(profileName);
  } catch {
    invalid.push({ field: 'HARTII_PROFILE', reason: `unknown profile "${profileName}" — expected "reckless" or "balanced"` });
  }

  // --- vault address ------------------------------------------------------------------------------
  let vaultAddress = null;
  if (env.HARTII_VAULT_ADDRESS) {
    try {
      vaultAddress = getAddress(env.HARTII_VAULT_ADDRESS.toLowerCase());
    } catch {
      invalid.push({ field: 'HARTII_VAULT_ADDRESS', reason: 'not a valid Quai address' });
    }
  }
  // Required together only in live mode (a real key resolved and HARTII_PAPER wasn't forced) —
  // see INTERFACES.md#env footnote. A misconfigured live run must fail loudly, never silently
  // fall back to paper.
  if (!paperMode && !env.HARTII_VAULT_ADDRESS) {
    missing.push('HARTII_VAULT_ADDRESS');
  }

  // --- telegram (both-or-neither; a single half-set var is treated as "not configured" rather
  // than a hard error, since reporting is optional) ------------------------------------------------
  const botToken = trimmedOrEmpty(env.TELEGRAM_BOT_TOKEN);
  const chatId = trimmedOrEmpty(env.TELEGRAM_CHAT_ID);
  const telegram = botToken && chatId ? { botToken, chatId } : null;

  // --- numeric overrides --------------------------------------------------------------------------
  const maxActionsPerCycle = parsePositiveInt(env.HARTII_MAX_ACTIONS_PER_CYCLE, DEFAULTS.maxActionsPerCycle);
  if (maxActionsPerCycle === null) {
    invalid.push({ field: 'HARTII_MAX_ACTIONS_PER_CYCLE', reason: 'must be a positive integer' });
  }
  const cycleIntervalMs = parsePositiveInt(env.HARTII_CYCLE_INTERVAL_MS, DEFAULTS.cycleIntervalMs);
  if (cycleIntervalMs === null) {
    invalid.push({ field: 'HARTII_CYCLE_INTERVAL_MS', reason: 'must be a positive integer' });
  }
  const maxPriceImpactPct = parseOptionalFiniteNumber(env.HARTII_MAX_PRICE_IMPACT_PCT);
  if (maxPriceImpactPct === null) {
    invalid.push({ field: 'HARTII_MAX_PRICE_IMPACT_PCT', reason: 'must be a finite number' });
  }

  // --- state paths ----------------------------------------------------------------------------
  const stateDir = resolveStatePath(env.HARTII_STATE_DIR || DEFAULT_STATE_DIR);
  const killSwitchFile = env.HARTII_KILL_SWITCH_FILE ? resolveStatePath(env.HARTII_KILL_SWITCH_FILE) : path.join(stateDir, 'STOP');
  const statusFile = path.join(stateDir, 'status.json');
  const ledgerFile = path.join(stateDir, 'ledger.json');
  const memoryFile = path.join(stateDir, 'memory.json');

  if (missing.length || invalid.length) {
    throw new ConfigError({ missing, invalid });
  }

  const config = {
    paperMode,
    dryRun,
    profile: profileName,
    apiBase: env.HARTII_API_BASE || DEFAULTS.apiBase,
    rpcUrl: env.HARTII_RPC_URL || DEFAULTS.rpcUrl,
    chainId: DEFAULTS.chainId,
    vaultAddress,
    hasAgentKey: Boolean(resolveKey),
    telegram,
    ntfyUrl: env.NTFY_URL || null,
    cycleIntervalMs,
    maxActionsPerCycle,
    launchesEnabled,
    killSwitchFile,
    statusFile,
    ledgerFile,
    memoryFile,
  };
  // Additive, optional (see src/tools#resolveMaxPriceImpactPct / DEFAULTS fallback) — only set
  // when the operator actually overrode it, so "unset" and "explicitly the profile default"
  // stay distinguishable.
  if (maxPriceImpactPct !== undefined) config.maxPriceImpactPct = maxPriceImpactPct;

  Object.defineProperty(config, KEY_MATERIAL, {
    value: resolveKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(config);
}

/**
 * @param {Config} config
 * @returns {string} the agent key material, only for signing use inside src/chain.
 * @throws {Error} if config.paperMode is true.
 */
export function getAgentKeyMaterial(config) {
  if (config?.paperMode) {
    throw new Error('src/config#getAgentKeyMaterial: refusing — config.paperMode is true, paper mode must never need a key');
  }
  const resolver = config?.[KEY_MATERIAL];
  if (typeof resolver !== 'function') {
    throw new Error('src/config#getAgentKeyMaterial: no agent key is configured (config was not produced by loadConfig, or no key resolved)');
  }
  return resolver();
}
