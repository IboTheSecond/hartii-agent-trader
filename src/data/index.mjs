// src/data — public HartiiLabs HTTP API client (https://hartiilabs.com, see /llms.txt and
// /api/agent/manifest). Every method retries transient failures with backoff and accepts an
// injectable fetchImpl so unit tests never touch the network.
// Contract: see INTERFACES.md#src-data.

function notImplemented(fn) {
  throw new Error(`src/data: ${fn} not implemented — see INTERFACES.md`);
}

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {unknown} [body]
   */
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Strips/truncates untrusted free text (description, socials dropped entirely; name/symbol
 * truncated; control characters stripped) before a token row is safe to interpolate into any
 * agent prompt. Every prompt-building caller MUST pass rows through this first.
 * @param {object} tokenRow
 * @returns {object}
 */
export function sanitizeTokenText(tokenRow) {
  return notImplemented('sanitizeTokenText');
}

/**
 * @param {{ apiBase?: string, fetchImpl?: typeof fetch, cacheTtlMs?: number }} [opts]
 */
export function createApiClient(opts = {}) {
  return {
    /** @returns {Promise<object>} Manifest */
    async getManifest() {
      return notImplemented('ApiClient#getManifest');
    },
    /** @returns {Promise<object[]>} TokenListItem[] */
    async getTokens({ sort = 'trending', limit = 30, cursor } = {}) {
      return notImplemented('ApiClient#getTokens');
    },
    /** @returns {Promise<object>} TokenDetail */
    async getToken(address) {
      return notImplemented('ApiClient#getToken');
    },
    /** @returns {Promise<object>} LiquidityInfo */
    async getLiquidity(address) {
      return notImplemented('ApiClient#getLiquidity');
    },
    /** @returns {Promise<object[]>} Candle[] */
    async getCandles(address, { tf = '5m', limit = 100 } = {}) {
      return notImplemented('ApiClient#getCandles');
    },
    /** @returns {Promise<object[]>} Trade[] */
    async getTrades(address, { limit = 50 } = {}) {
      return notImplemented('ApiClient#getTrades');
    },
    /** @returns {Promise<object[]>} Holder[] */
    async getHolders(address, { limit = 50 } = {}) {
      return notImplemented('ApiClient#getHolders');
    },
    /** @returns {Promise<object[]>} Trade[] */
    async getRecentTrades({ limit = 50 } = {}) {
      return notImplemented('ApiClient#getRecentTrades');
    },
    /** @returns {Promise<object>} VaultState */
    async getVault(vaultAddress) {
      return notImplemented('ApiClient#getVault');
    },
    /** @returns {Promise<object>} Quote */
    async getQuote({ token, side, amountWei }) {
      return notImplemented('ApiClient#getQuote');
    },
  };
}
