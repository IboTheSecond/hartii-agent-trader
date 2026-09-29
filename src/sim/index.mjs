// src/sim — paper-trading engine (same tool surface as live, fills simulated from live
// quotes) and replay/eval over public trade history.
// Contract: see INTERFACES.md#src-sim.
//
// Design notes (implementation details INTERFACES.md leaves to this module — see
// INTERFACE-REQUESTS.md for anything that should get pinned upstream instead):
//   - createPaperEngine simulates fills from `api.getQuote` — the exact same live-quote path a
//     real buy/sell would hit — so a paper cycle exercises the real quoting logic end to end;
//     only the "does a transaction actually get signed and sent" step is skipped.
//   - replayHistory works over historical candles (api.getCandles), not live quotes, since it
//     replays a strategy against a fixed time window in the past. `initialQuaiWei` isn't in the
//     pinned signature; it's accepted as an additional optional field (default below) rather
//     than a hardcoded constant, since a caller must be able to size a backtest realistically.

const WEI_PER_QUAI = 10n ** 18n;
export const DEFAULT_REPLAY_INITIAL_QUAI_WEI = 1000n * WEI_PER_QUAI;
export const DEFAULT_REPLAY_CANDLE_TF = '5m';
export const DEFAULT_REPLAY_CANDLE_LIMIT = 1000;
// Same default magnitude as replay's, kept as a separate export since a live paper *session*'s
// starting balance and a one-off *backtest*'s could reasonably diverge later even though they
// don't today — see derivePaperPortfolioFromLedger below.
export const DEFAULT_PAPER_STARTING_QUAI_WEI = 1000n * WEI_PER_QUAI;

function toBigInt(value, label) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value.length > 0) return BigInt(value);
  throw new TypeError(`${label}: expected a bigint, integer number, or decimal-string, got ${JSON.stringify(value)}`);
}

/**
 * @param {{ initialQuaiWei: bigint, api: object, initialPositions?: Record<string, bigint> }} opts
 * `initialPositions` is additive to the pinned `{initialQuaiWei, api}` signature — needed to
 * seed a freshly-constructed engine with positions a session already holds (e.g. reconstructed
 * from a ledger — see src/runner's DI seam and INTERFACE-REQUESTS.md on why a PaperEngine can't
 * literally persist across the process boundary a spawned MCP-server subprocess crosses).
 */
export function createPaperEngine({ initialQuaiWei, api, initialPositions = {} }) {
  if (typeof initialQuaiWei !== 'bigint') {
    throw new TypeError('createPaperEngine: initialQuaiWei must be a bigint');
  }
  if (!api || typeof api.getQuote !== 'function') {
    throw new TypeError('createPaperEngine: api.getQuote is required');
  }

  let quaiWei = initialQuaiWei;
  /** @type {Record<string, bigint>} */
  const positions = {};
  for (const [token, amount] of Object.entries(initialPositions)) {
    if (typeof amount === 'bigint' && amount > 0n) positions[token] = amount;
  }

  return {
    /**
     * Quotes the buy live, then simulates the fill against the quoted output — the same
     * slippage-floor and "can we actually afford this" checks a real buy would face.
     * @returns {Promise<{ ok: boolean, filledTokensWei?: bigint, error?: string }>}
     */
    async buy(token, amountInWei, minTokensOutWei) {
      try {
        amountInWei = toBigInt(amountInWei, 'buy(amountInWei)');
        minTokensOutWei = toBigInt(minTokensOutWei, 'buy(minTokensOutWei)');
      } catch (err) {
        return { ok: false, error: err.message };
      }
      if (amountInWei <= 0n) return { ok: false, error: 'amountInWei must be > 0' };
      if (amountInWei > quaiWei) return { ok: false, error: 'insufficient paper QUAI balance' };

      let quote;
      try {
        quote = await api.getQuote({ token, side: 'buy', amountWei: amountInWei.toString() });
      } catch (err) {
        return { ok: false, error: `quote failed: ${err?.message || err}` };
      }

      let filledTokensWei;
      try {
        filledTokensWei = toBigInt(quote?.amountOut, 'quote.amountOut');
      } catch (err) {
        return { ok: false, error: `bad quote: ${err.message}` };
      }
      if (filledTokensWei < minTokensOutWei) {
        return { ok: false, error: `slippage: filled ${filledTokensWei} < minTokensOutWei ${minTokensOutWei}` };
      }

      quaiWei -= amountInWei;
      positions[token] = (positions[token] || 0n) + filledTokensWei;
      return { ok: true, filledTokensWei };
    },

    /**
     * Quotes the sell live, then simulates the fill against the quoted output.
     * @returns {Promise<{ ok: boolean, filledQuaiWei?: bigint, error?: string }>}
     */
    async sell(token, tokensInWei, minQuaiOutWei) {
      try {
        tokensInWei = toBigInt(tokensInWei, 'sell(tokensInWei)');
        minQuaiOutWei = toBigInt(minQuaiOutWei, 'sell(minQuaiOutWei)');
      } catch (err) {
        return { ok: false, error: err.message };
      }
      if (tokensInWei <= 0n) return { ok: false, error: 'tokensInWei must be > 0' };
      const held = positions[token] || 0n;
      if (tokensInWei > held) return { ok: false, error: 'insufficient paper token position' };

      let quote;
      try {
        quote = await api.getQuote({ token, side: 'sell', amountWei: tokensInWei.toString() });
      } catch (err) {
        return { ok: false, error: `quote failed: ${err?.message || err}` };
      }

      let filledQuaiWei;
      try {
        filledQuaiWei = toBigInt(quote?.amountOut, 'quote.amountOut');
      } catch (err) {
        return { ok: false, error: `bad quote: ${err.message}` };
      }
      if (filledQuaiWei < minQuaiOutWei) {
        return { ok: false, error: `slippage: filled ${filledQuaiWei} < minQuaiOutWei ${minQuaiOutWei}` };
      }

      positions[token] = held - tokensInWei;
      if (positions[token] === 0n) delete positions[token];
      quaiWei += filledQuaiWei;
      return { ok: true, filledQuaiWei };
    },

    /** @returns {{ quaiWei: bigint, positions: Record<string, bigint> }} */
    getState() {
      return { quaiWei, positions: { ...positions } };
    },
  };
}

/**
 * One historical-candle-driven trade, as returned by a strategyFn.
 * @typedef {{ side: 'buy' | 'sell', amountWei: string }} Action
 */

function makeReplayTradeRecord({ side, token, amountQuaiWei, amountTokenWei, priceQuaiPerTokenWei, atMs }) {
  return {
    id: `replay-${atMs}-${side}-${Math.random().toString(36).slice(2, 8)}`,
    atMs,
    side,
    token,
    symbol: null,
    amountQuaiWei: amountQuaiWei.toString(),
    amountTokenWei: amountTokenWei.toString(),
    priceQuaiPerTokenWei: priceQuaiPerTokenWei.toString(),
    txHash: null,
    gasWei: null,
    reason: 'replay',
    paper: true,
  };
}

/**
 * Replays a strategy over a token's historical candles between fromMs and toMs, simulating
 * fills directly from each candle's close price (no live quoting — the point is to answer "what
 * would this strategy have done historically", entirely offline once the candles are fetched).
 * @param {{ api: object, tokenAddress: string, fromMs: number, toMs: number, strategyFn: (candle: object, state: { quaiWei: bigint, positions: Record<string, bigint> }) => Action | null, initialQuaiWei?: bigint, candleTf?: string, candleLimit?: number }} opts
 * @returns {Promise<object>} ReplayResult
 */
export async function replayHistory({
  api,
  tokenAddress,
  fromMs,
  toMs,
  strategyFn,
  initialQuaiWei = DEFAULT_REPLAY_INITIAL_QUAI_WEI,
  candleTf = DEFAULT_REPLAY_CANDLE_TF,
  candleLimit = DEFAULT_REPLAY_CANDLE_LIMIT,
}) {
  if (!api || typeof api.getCandles !== 'function') throw new TypeError('replayHistory: api.getCandles is required');
  if (!tokenAddress) throw new TypeError('replayHistory: tokenAddress is required');
  if (typeof strategyFn !== 'function') throw new TypeError('replayHistory: strategyFn is required');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new TypeError('replayHistory: fromMs/toMs must be finite numbers with fromMs <= toMs');
  }

  const candles = await api.getCandles(tokenAddress, { tf: candleTf, limit: candleLimit });
  const inRange = (candles || [])
    .filter((c) => Number.isFinite(c?.t) && c.t >= fromMs && c.t <= toMs)
    .sort((a, b) => a.t - b.t);

  let quaiWei = initialQuaiWei;
  const positions = {};
  const trades = [];

  for (const candle of inRange) {
    const state = { quaiWei, positions: { ...positions } };
    const action = strategyFn(candle, state);
    if (!action) continue;

    let priceWeiPerToken;
    try {
      priceWeiPerToken = toBigInt(candle.c, 'candle.c');
    } catch {
      continue; // a candle with an unusable close price can't be traded against — skip it
    }
    if (priceWeiPerToken <= 0n) continue;

    if (action.side === 'buy') {
      let amountInWei;
      try {
        amountInWei = toBigInt(action.amountWei, 'action.amountWei');
      } catch {
        continue;
      }
      if (amountInWei <= 0n || amountInWei > quaiWei) continue;
      const tokensOut = (amountInWei * WEI_PER_QUAI) / priceWeiPerToken;
      if (tokensOut <= 0n) continue;
      quaiWei -= amountInWei;
      positions[tokenAddress] = (positions[tokenAddress] || 0n) + tokensOut;
      trades.push(makeReplayTradeRecord({ side: 'buy', token: tokenAddress, amountQuaiWei: amountInWei, amountTokenWei: tokensOut, priceQuaiPerTokenWei: priceWeiPerToken, atMs: candle.t }));
    } else if (action.side === 'sell') {
      let tokensInWei;
      try {
        tokensInWei = toBigInt(action.amountWei, 'action.amountWei');
      } catch {
        continue;
      }
      const held = positions[tokenAddress] || 0n;
      const sellWei = tokensInWei > held ? held : tokensInWei;
      if (sellWei <= 0n) continue;
      const quaiOut = (sellWei * priceWeiPerToken) / WEI_PER_QUAI;
      positions[tokenAddress] = held - sellWei;
      if (positions[tokenAddress] === 0n) delete positions[tokenAddress];
      quaiWei += quaiOut;
      trades.push(makeReplayTradeRecord({ side: 'sell', token: tokenAddress, amountQuaiWei: quaiOut, amountTokenWei: sellWei, priceQuaiPerTokenWei: priceWeiPerToken, atMs: candle.t }));
    }
  }

  return { trades, finalState: { quaiWei, positions } };
}

/**
 * Average-cost realized PnL + win rate over a flat list of trades (as produced by replayHistory
 * or read back from a real ledger's trades[]). Pure, local, and deliberately independent of
 * src/ledger's own average-cost bookkeeping (different module, different purpose: this scores a
 * finished trade list after the fact rather than maintaining live position state), so this
 * module never has to import a sibling module's not-yet-implemented internals to be unit-tested.
 * @param {object[]} trades TradeRecord[]
 * @returns {{ realizedPnlWei: bigint, winRate: number, trades: number }}
 */
export function evalStrategy(trades) {
  if (!Array.isArray(trades)) throw new TypeError('evalStrategy: trades must be an array');

  /** @type {Record<string, { amountWei: bigint, costBasisWei: bigint }>} */
  const positions = {};
  let realizedPnlWei = 0n;
  let sells = 0;
  let wins = 0;

  for (const t of trades) {
    if (!t || (t.side !== 'buy' && t.side !== 'sell')) continue;
    const token = t.token;
    const amountToken = toBigInt(t.amountTokenWei ?? '0', 'trade.amountTokenWei');
    const amountQuai = toBigInt(t.amountQuaiWei ?? '0', 'trade.amountQuaiWei');
    const pos = positions[token] || { amountWei: 0n, costBasisWei: 0n };

    if (t.side === 'buy') {
      pos.amountWei += amountToken;
      pos.costBasisWei += amountQuai;
      positions[token] = pos;
      continue;
    }

    // sell
    if (pos.amountWei <= 0n) continue; // selling with no tracked position: nothing to realize
    const sellAmount = amountToken > pos.amountWei ? pos.amountWei : amountToken;
    const costOfSold = (pos.costBasisWei * sellAmount) / pos.amountWei;
    const realized = amountQuai - costOfSold;
    realizedPnlWei += realized;
    pos.amountWei -= sellAmount;
    pos.costBasisWei -= costOfSold;
    positions[token] = pos;
    sells += 1;
    if (realized > 0n) wins += 1;
  }

  return { realizedPnlWei, winRate: sells > 0 ? wins / sells : 0, trades: trades.length };
}

/**
 * Reconstructs a paper session's current cash + position amounts purely from a Ledger — the
 * durable, cross-process source of truth for paper state. This matters because a PaperEngine
 * instance itself does NOT persist across process boundaries: each sandboxed `claude -p` /
 * MCP-server subprocess (see INTERFACE-REQUESTS.md's src/agents entry on bin/mcp-server.mjs) is
 * a fresh OS process, so "one PaperEngine per run, passed through" can only mean "reconstructed
 * from the same durable ledger.json every time," not a literal shared JS object. Every paper
 * trade already goes through src/ledger#recordTrade (same as a live one), so this is exact, not
 * an approximation: cash = deposits - buys + sells (gas optionally netted out too, since a paper
 * session should rehearse gas drag the same way a live one experiences it).
 * @param {object} ledger Ledger
 * @param {{ includeGas?: boolean }} [opts]
 * @returns {{ quaiWei: bigint, positions: Record<string, bigint> }}
 */
export function derivePaperPortfolioFromLedger(ledger, { includeGas = true } = {}) {
  let quaiWei = toBigInt(ledger?.totalDepositedWei ?? '0', 'ledger.totalDepositedWei');
  for (const t of ledger?.trades || []) {
    const amt = toBigInt(t.amountQuaiWei ?? '0', 'trade.amountQuaiWei');
    quaiWei += t.side === 'sell' ? amt : -amt;
  }
  if (includeGas) quaiWei -= toBigInt(ledger?.gasSpentWei ?? '0', 'ledger.gasSpentWei');

  const positions = {};
  for (const [token, pos] of Object.entries(ledger?.positions || {})) {
    const amountWei = toBigInt(pos?.amountWei ?? '0', 'position.amountWei');
    if (amountWei > 0n) positions[token] = amountWei;
  }
  return { quaiWei, positions };
}
