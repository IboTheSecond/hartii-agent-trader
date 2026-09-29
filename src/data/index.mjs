// src/data — public HartiiLabs HTTP API client (https://hartiilabs.com, see /llms.txt and
// /api/agent/manifest). Every method retries transient failures with backoff and accepts an
// injectable fetchImpl so unit tests never touch the network.
// Contract: see INTERFACES.md#src-data.

const DEFAULT_API_BASE = 'https://hartiilabs.com';
const DEFAULT_CACHE_TTL_MS = 5000;
const DEFAULT_RETRIES = 3; // total attempts = DEFAULT_RETRIES + 1
const DEFAULT_BACKOFF_MS = 150;

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

function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a full URL from a base, a path, and optional query params. Undefined/null params are
 * omitted entirely rather than serialized as "undefined".
 * @param {string} apiBase
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
function buildUrl(apiBase, path, params) {
  const url = new URL(path, apiBase);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Fetches JSON from `url`, retrying transient failures (network error, 429, 5xx) with
 * exponential backoff. Throws ApiError once retries are exhausted or on a non-retryable status.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {{ retries?: number, backoffMs?: number }} [opts]
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, fetchImpl, { retries = DEFAULT_RETRIES, backoffMs = DEFAULT_BACKOFF_MS } = {}) {
  let lastNetworkError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      lastNetworkError = err;
      if (attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      throw new ApiError(`network error fetching ${url}: ${err && err.message ? err.message : err}`, 0, null);
    }

    if (res.ok) {
      try {
        return await res.json();
      } catch (err) {
        throw new ApiError(`invalid JSON response from ${url}: ${err && err.message ? err.message : err}`, res.status, null);
      }
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body — leave body as null
    }

    if (isTransientStatus(res.status) && attempt < retries) {
      await sleep(backoffMs * 2 ** attempt);
      continue;
    }

    throw new ApiError(`hartiilabs API error ${res.status} for ${url}`, res.status, body);
  }
  // unreachable in practice, but keeps control flow explicit
  throw lastNetworkError instanceof Error
    ? new ApiError(`network error fetching ${url}: ${lastNetworkError.message}`, 0, null)
    : new ApiError(`exhausted retries fetching ${url}`, 0, null);
}

// --- untrusted-text sanitizing -------------------------------------------------------------

// Free-text / link-shaped fields are dropped entirely — never interpolated into any agent
// prompt. Anything not explicitly allow-listed here that is a nested object/array is dropped
// too, so an unexpected field can never smuggle structured content into a prompt.
const FREE_TEXT_KEYS = new Set([
  'description', 'desc', 'bio', 'about', 'summary', 'socials', 'social', 'links',
  'website', 'twitter', 'x', 'telegram', 'discord', 'github', 'url', 'imageurl', 'image',
  'banner', 'tags', 'notes', 'comment', 'comments', 'memo',
]);

const MAX_NAME_LEN = 40;
const MAX_SYMBOL_LEN = 16;
const MAX_GENERIC_STRING_LEN = 128;

function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex -- intentional: strip C0/DEL control chars
  return String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/**
 * Strips/truncates untrusted free text (description, socials, links dropped entirely;
 * name/symbol truncated; control characters stripped) before a token row is safe to
 * interpolate into any agent prompt. Every prompt-building caller MUST pass rows through this
 * first. Allow-lists scalar fields and drops nested objects/arrays entirely — an unexpected
 * field can never smuggle structured or oversized content into a prompt.
 * @param {object} tokenRow
 * @returns {object}
 */
export function sanitizeTokenText(tokenRow) {
  if (!tokenRow || typeof tokenRow !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(tokenRow)) {
    if (FREE_TEXT_KEYS.has(key.toLowerCase())) continue;
    if (value !== null && typeof value === 'object') continue; // drop nested objects/arrays
    if (typeof value === 'string') {
      const cleaned = stripControlChars(value);
      if (key === 'name') out[key] = cleaned.slice(0, MAX_NAME_LEN);
      else if (key === 'symbol') out[key] = cleaned.slice(0, MAX_SYMBOL_LEN);
      else out[key] = cleaned.slice(0, MAX_GENERIC_STRING_LEN);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
    // functions, symbols, undefined: silently dropped
  }
  return out;
}

// --- wire-format normalization ------------------------------------------------------------------
// The live API's actual response envelopes/field names (confirmed live against hartiilabs.com
// 2026-09-29 — see INTERFACE-REQUESTS.md's integration entry) differ from this module's pinned
// INTERFACES.md#src-data output types in two ways this section reconciles: list endpoints wrap
// their array in an envelope object instead of returning it bare, and several per-row field
// names differ from the pinned type. Every method below normalizes at the boundary (this file),
// exactly once, so nothing downstream ever has to know about the raw wire format.

/** Unwraps a list endpoint's `{ ..., items: [...] }` envelope; also accepts a bare array
 * (defensive/forward-compatible — never throws on an unexpected shape). */
function unwrapItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

/** `/api/token/:addr` wraps its payload as `{ token: {...} }`; also accepts a bare object. */
function unwrapToken(raw) {
  if (raw && typeof raw === 'object' && raw.token && typeof raw.token === 'object') return raw.token;
  return raw && typeof raw === 'object' ? raw : {};
}

/** Maps one raw candle row (`bucketStart`/`open`/`high`/`low`/`close`/`volumeQuai`, bucketStart
 * in whole seconds) to the pinned `{t,o,h,l,c,volumeWei}` shape (t in milliseconds, matching
 * every other *AtMs field in this codebase). Passes an already-normalized row through unchanged. */
function normalizeCandle(c) {
  const t = typeof c?.bucketStart === 'number' ? c.bucketStart * 1000 : c?.t;
  return {
    t,
    o: c?.o ?? c?.open ?? null,
    h: c?.h ?? c?.high ?? null,
    l: c?.l ?? c?.low ?? null,
    c: c?.c ?? c?.close ?? null,
    volumeWei: c?.volumeWei ?? c?.volumeQuai ?? '0',
  };
}

/** Maps one raw trade row (`trader`/`quaiAmount`/`tokenAmount`/`blockTime`) to the pinned
 * `{txHash,side,wallet,amountQuaiWei,amountTokenWei,at}` shape. `/api/trades/recent` rows carry
 * no `tokenAmount` at all — defaults to '0' rather than fabricating a value. */
function normalizeTrade(t) {
  return {
    txHash: t?.txHash ?? null,
    side: t?.side ?? null,
    wallet: t?.wallet ?? t?.trader ?? null,
    amountQuaiWei: t?.amountQuaiWei ?? t?.quaiAmount ?? '0',
    amountTokenWei: t?.amountTokenWei ?? t?.tokenAmount ?? '0',
    at: t?.at ?? t?.blockTime ?? null,
  };
}

/** Maps one raw holder row (`holder`/`balance`) to the pinned `{wallet,amountWei,pct}` shape.
 * The live API reports no percentage at all — `pct: null` (never a fabricated 0) when absent, so
 * a caller that needs it can compute it against a known total supply (see
 * src/tools#summarizeHolders) instead of silently treating "unknown" as "zero". */
function normalizeHolder(h) {
  return {
    wallet: h?.wallet ?? h?.holder ?? null,
    amountWei: h?.amountWei ?? h?.balance ?? '0',
    pct: typeof h?.pct === 'number' ? h.pct : null,
  };
}

// --- API client ------------------------------------------------------------------------------

/**
 * @param {{ apiBase?: string, fetchImpl?: typeof fetch, cacheTtlMs?: number, retries?: number, retryBackoffMs?: number }} [opts]
 */
export function createApiClient(opts = {}) {
  const {
    apiBase = DEFAULT_API_BASE,
    fetchImpl = fetch,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    retries = DEFAULT_RETRIES,
    retryBackoffMs = DEFAULT_BACKOFF_MS,
  } = opts;

  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  const cache = new Map();

  /**
   * @param {string} path
   * @param {Record<string, unknown>} [params]
   * @param {{ cacheable?: boolean }} [cacheOpts]
   */
  async function get(path, params, { cacheable = true } = {}) {
    const url = buildUrl(apiBase, path, params);
    if (cacheable && cacheTtlMs > 0) {
      const hit = cache.get(url);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
    }
    const value = await fetchJson(url, fetchImpl, { retries, backoffMs: retryBackoffMs });
    if (cacheable && cacheTtlMs > 0) {
      cache.set(url, { value, expiresAt: Date.now() + cacheTtlMs });
    }
    return value;
  }

  return {
    /** @returns {Promise<object>} Manifest */
    async getManifest() {
      return get('/api/agent/manifest');
    },
    /** @returns {Promise<object[]>} TokenListItem[] */
    async getTokens({ sort = 'trending', limit = 30, cursor } = {}) {
      const raw = await get('/api/tokens', { sort, limit, cursor });
      return unwrapItems(raw);
    },
    /** @returns {Promise<object>} TokenDetail */
    async getToken(address) {
      if (!address) throw new TypeError('getToken: address is required');
      const raw = await get(`/api/token/${encodeURIComponent(address)}`);
      return unwrapToken(raw);
    },
    /** @returns {Promise<object>} LiquidityInfo */
    async getLiquidity(address) {
      if (!address) throw new TypeError('getLiquidity: address is required');
      return get(`/api/token/${encodeURIComponent(address)}/liquidity`);
    },
    /** @returns {Promise<object[]>} Candle[] */
    async getCandles(address, { tf = '5m', limit = 100 } = {}) {
      if (!address) throw new TypeError('getCandles: address is required');
      const raw = await get(`/api/token/${encodeURIComponent(address)}/candles`, { tf, limit });
      return unwrapItems(raw).map(normalizeCandle);
    },
    /** @returns {Promise<object[]>} Trade[] */
    async getTrades(address, { limit = 50 } = {}) {
      if (!address) throw new TypeError('getTrades: address is required');
      const raw = await get(`/api/token/${encodeURIComponent(address)}/trades`, { limit });
      return unwrapItems(raw).map(normalizeTrade);
    },
    /** @returns {Promise<object[]>} Holder[] */
    async getHolders(address, { limit = 50 } = {}) {
      if (!address) throw new TypeError('getHolders: address is required');
      const raw = await get(`/api/token/${encodeURIComponent(address)}/holders`, { limit });
      return unwrapItems(raw).map(normalizeHolder);
    },
    /** @returns {Promise<object[]>} Trade[] */
    async getRecentTrades({ limit = 50 } = {}) {
      const raw = await get('/api/trades/recent', { limit });
      return unwrapItems(raw).map(normalizeTrade);
    },
    /** @returns {Promise<object>} VaultState */
    async getVault(vaultAddress) {
      if (!vaultAddress) throw new TypeError('getVault: vaultAddress is required');
      // vault state (balances, caps, spent-today) changes every block — never serve it stale.
      return get(`/api/agent/vault/${encodeURIComponent(vaultAddress)}`, undefined, { cacheable: false });
    },
    /** @returns {Promise<object>} Quote */
    async getQuote({ token, side, amountWei }) {
      if (!token) throw new TypeError('getQuote: token is required');
      if (side !== 'buy' && side !== 'sell') throw new TypeError('getQuote: side must be "buy" or "sell"');
      if (!amountWei) throw new TypeError('getQuote: amountWei is required');
      // price-sensitive — never cached, always a live quote. The live endpoint returns
      // {token,side,amountInWei,feeWei,expectedOutWei,graduated,isV3,at} — no amountOut/
      // priceImpact/minOut fields at all (unlike this module's pinned Quote type) — mapped below;
      // priceImpact stays null here (this endpoint doesn't provide one) for the caller
      // (src/tools#executeGuardedTrade) to compute against a known spot price, or reject rather
      // than assume 0% impact — see that module's computePriceImpactPct.
      const raw = await get('/api/agent/quote', { token, side, amountWei }, { cacheable: false });
      return {
        amountIn: raw?.amountIn ?? raw?.amountInWei ?? amountWei,
        amountOut: raw?.amountOut ?? raw?.expectedOutWei ?? null,
        priceImpact: typeof raw?.priceImpact === 'number' ? raw.priceImpact : null,
        minOut: raw?.minOut ?? null,
        feeWei: raw?.feeWei ?? null,
        graduated: typeof raw?.graduated === 'boolean' ? raw.graduated : null,
        isV3: typeof raw?.isV3 === 'boolean' ? raw.isV3 : null,
      };
    },
  };
}
