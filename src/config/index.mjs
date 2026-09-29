// src/config — env loading/validation, risk profiles, constants.
// Contract: see INTERFACES.md#src-config. Depends on nothing else in src/.

function notImplemented(fn) {
  throw new Error(`src/config: ${fn} not implemented — see INTERFACES.md`);
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

/**
 * Loads and validates runtime configuration from environment variables. Never returns a
 * partially-valid Config — either throws ConfigError or returns a fully valid one.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  return notImplemented('loadConfig');
}

/**
 * @param {Config} config
 * @returns {string} the agent key material, only for signing use inside src/chain.
 * @throws {Error} if config.paperMode is true.
 */
export function getAgentKeyMaterial(config) {
  return notImplemented('getAgentKeyMaterial');
}
