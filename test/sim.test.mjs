import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaperEngine, replayHistory, evalStrategy, derivePaperPortfolioFromLedger, DEFAULT_REPLAY_INITIAL_QUAI_WEI } from '../src/sim/index.mjs';

const QUAI = 10n ** 18n;
const TOKEN = '0x000000000000000000000000000000000000aa';

function fakeApi({ buyOut, sellOut, getQuoteImpl, getCandlesImpl } = {}) {
  return {
    async getQuote({ token, side, amountWei }) {
      if (getQuoteImpl) return getQuoteImpl({ token, side, amountWei });
      if (side === 'buy') return { amountIn: amountWei, amountOut: (buyOut ?? 1000n * QUAI).toString(), priceImpact: 1, minOut: '0' };
      return { amountIn: amountWei, amountOut: (sellOut ?? 1n * QUAI).toString(), priceImpact: 1, minOut: '0' };
    },
    async getCandles(token, opts) {
      if (getCandlesImpl) return getCandlesImpl(token, opts);
      return [];
    },
  };
}

// --- createPaperEngine -----------------------------------------------------------------------

test('sim: paper engine buy fills from api.getQuote and updates state', async () => {
  const api = fakeApi({ buyOut: 500n * QUAI });
  const engine = createPaperEngine({ initialQuaiWei: 10n * QUAI, api });

  const result = await engine.buy(TOKEN, 1n * QUAI, 1n);
  assert.equal(result.ok, true);
  assert.equal(result.filledTokensWei, 500n * QUAI);

  const state = engine.getState();
  assert.equal(state.quaiWei, 9n * QUAI);
  assert.equal(state.positions[TOKEN], 500n * QUAI);
});

test('sim: paper engine buy rejects when the paper balance cannot afford it', async () => {
  const api = fakeApi();
  const engine = createPaperEngine({ initialQuaiWei: 1n * QUAI, api });
  const result = await engine.buy(TOKEN, 5n * QUAI, 1n);
  assert.equal(result.ok, false);
  assert.match(result.error, /insufficient/i);
  assert.equal(engine.getState().quaiWei, 1n * QUAI); // untouched
});

test('sim: paper engine buy rejects a fill under the slippage floor', async () => {
  const api = fakeApi({ buyOut: 10n }); // way below minTokensOutWei
  const engine = createPaperEngine({ initialQuaiWei: 10n * QUAI, api });
  const result = await engine.buy(TOKEN, 1n * QUAI, 1000n * QUAI);
  assert.equal(result.ok, false);
  assert.match(result.error, /slippage/i);
  assert.equal(engine.getState().quaiWei, 10n * QUAI); // untouched — rejected fill never applies
});

test('sim: paper engine sell fills from api.getQuote and updates state, clearing a fully-sold position', async () => {
  const api = fakeApi({ buyOut: 500n * QUAI, sellOut: 2n * QUAI });
  const engine = createPaperEngine({ initialQuaiWei: 10n * QUAI, api });
  await engine.buy(TOKEN, 1n * QUAI, 1n);

  const result = await engine.sell(TOKEN, 500n * QUAI, 1n);
  assert.equal(result.ok, true);
  assert.equal(result.filledQuaiWei, 2n * QUAI);

  const state = engine.getState();
  assert.equal(state.quaiWei, 11n * QUAI); // 10 - 1 (buy) + 2 (sell)
  assert.equal(state.positions[TOKEN], undefined); // fully sold — cleared, not left at 0n
});

test('sim: paper engine sell rejects selling more than the tracked position', async () => {
  const api = fakeApi();
  const engine = createPaperEngine({ initialQuaiWei: 10n * QUAI, api });
  const result = await engine.sell(TOKEN, 1n * QUAI, 0n);
  assert.equal(result.ok, false);
  assert.match(result.error, /position/i);
});

test('sim: paper engine surfaces a quote failure as ok:false, never throws', async () => {
  const api = fakeApi({ getQuoteImpl: async () => { throw new Error('network down'); } });
  const engine = createPaperEngine({ initialQuaiWei: 10n * QUAI, api });
  const result = await engine.buy(TOKEN, 1n * QUAI, 1n);
  assert.equal(result.ok, false);
  assert.match(result.error, /quote failed/);
});

test('sim: createPaperEngine accepts initialPositions to seed a session reconstructed from a ledger', async () => {
  const api = fakeApi({ sellOut: 3n * QUAI });
  const engine = createPaperEngine({ initialQuaiWei: 1n * QUAI, api, initialPositions: { [TOKEN]: 200n * QUAI } });
  assert.equal(engine.getState().positions[TOKEN], 200n * QUAI);
  const result = await engine.sell(TOKEN, 200n * QUAI, 1n);
  assert.equal(result.ok, true);
  assert.equal(engine.getState().quaiWei, 4n * QUAI);
});

test('sim: createPaperEngine ignores a zero/negative amount in initialPositions', () => {
  const engine = createPaperEngine({ initialQuaiWei: 1n * QUAI, api: fakeApi(), initialPositions: { [TOKEN]: 0n } });
  assert.equal(engine.getState().positions[TOKEN], undefined);
});

test('sim: createPaperEngine requires a bigint initialQuaiWei and an api with getQuote', () => {
  assert.throws(() => createPaperEngine({ initialQuaiWei: 5, api: fakeApi() }), TypeError);
  assert.throws(() => createPaperEngine({ initialQuaiWei: 5n * QUAI, api: {} }), TypeError);
});

// --- replayHistory -----------------------------------------------------------------------------

test('sim: replayHistory replays a buy-then-sell strategy over candles in range, from candle close prices', async () => {
  const candles = [
    { t: 100, o: '1', h: '1', l: '1', c: (1n * QUAI).toString(), volumeWei: '0' }, // price 1 QUAI/token
    { t: 200, o: '1', h: '1', l: '1', c: (2n * QUAI).toString(), volumeWei: '0' }, // price doubles
    { t: 9999, o: '1', h: '1', l: '1', c: (5n * QUAI).toString(), volumeWei: '0' }, // out of range
  ];
  const api = fakeApi({ getCandlesImpl: async () => candles });

  let calls = 0;
  const strategyFn = (candle, state) => {
    calls += 1;
    if (candle.t === 100) return { side: 'buy', amountWei: (10n * QUAI).toString() };
    if (candle.t === 200) return { side: 'sell', amountWei: state.positions[TOKEN]?.toString() ?? '0' };
    return null;
  };

  const result = await replayHistory({ api, tokenAddress: TOKEN, fromMs: 0, toMs: 500, strategyFn, initialQuaiWei: 100n * QUAI });

  assert.equal(calls, 2); // the out-of-range candle at t=9999 must never reach strategyFn
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].side, 'buy');
  assert.equal(result.trades[0].amountTokenWei, (10n * QUAI).toString()); // 10 QUAI / 1 QUAI-per-token
  assert.equal(result.trades[1].side, 'sell');
  // bought 10 tokens at price 1, sold at price 2 -> 20 QUAI back
  assert.equal(result.trades[1].amountQuaiWei, (20n * QUAI).toString());
  assert.equal(result.finalState.quaiWei, 100n * QUAI - 10n * QUAI + 20n * QUAI);
  assert.equal(result.finalState.positions[TOKEN], undefined);
});

test('sim: replayHistory defaults initialQuaiWei when not given', async () => {
  const api = fakeApi({ getCandlesImpl: async () => [] });
  const result = await replayHistory({ api, tokenAddress: TOKEN, fromMs: 0, toMs: 1, strategyFn: () => null });
  assert.equal(result.finalState.quaiWei, DEFAULT_REPLAY_INITIAL_QUAI_WEI);
  assert.deepEqual(result.trades, []);
});

test('sim: replayHistory never lets a strategy overspend its simulated balance', async () => {
  const candles = [{ t: 1, o: '1', h: '1', l: '1', c: (1n * QUAI).toString(), volumeWei: '0' }];
  const api = fakeApi({ getCandlesImpl: async () => candles });
  const strategyFn = () => ({ side: 'buy', amountWei: (1000n * QUAI).toString() }); // way more than the 1 QUAI balance
  const result = await replayHistory({ api, tokenAddress: TOKEN, fromMs: 0, toMs: 10, strategyFn, initialQuaiWei: 1n * QUAI });
  assert.equal(result.trades.length, 0);
  assert.equal(result.finalState.quaiWei, 1n * QUAI);
});

// --- evalStrategy ------------------------------------------------------------------------------

function trade({ side, token = TOKEN, amountQuaiWei, amountTokenWei }) {
  return { side, token, amountQuaiWei: amountQuaiWei.toString(), amountTokenWei: amountTokenWei.toString() };
}

test('sim: evalStrategy computes average-cost realized PnL and win rate across trades', () => {
  const trades = [
    trade({ side: 'buy', amountQuaiWei: 10n * QUAI, amountTokenWei: 100n * QUAI }), // cost 0.1 QUAI/token
    trade({ side: 'sell', amountQuaiWei: 15n * QUAI, amountTokenWei: 100n * QUAI }), // sold all -> +5 QUAI realized
  ];
  const result = evalStrategy(trades);
  assert.equal(result.realizedPnlWei, 5n * QUAI);
  assert.equal(result.winRate, 1);
  assert.equal(result.trades, 2);
});

test('sim: evalStrategy handles a partial sell at average cost and a losing trade', () => {
  const trades = [
    trade({ side: 'buy', amountQuaiWei: 20n * QUAI, amountTokenWei: 200n * QUAI }), // 0.1 QUAI/token avg cost
    trade({ side: 'sell', amountQuaiWei: 5n * QUAI, amountTokenWei: 100n * QUAI }), // cost basis for 100 = 10 QUAI -> -5 realized
  ];
  const result = evalStrategy(trades);
  assert.equal(result.realizedPnlWei, -5n * QUAI);
  assert.equal(result.winRate, 0);
});

test('sim: evalStrategy returns winRate 0 (never NaN) when there are no sells', () => {
  const result = evalStrategy([trade({ side: 'buy', amountQuaiWei: 1n * QUAI, amountTokenWei: 10n * QUAI })]);
  assert.equal(result.realizedPnlWei, 0n);
  assert.equal(result.winRate, 0);
});

test('sim: evalStrategy ignores a sell with no tracked position instead of throwing', () => {
  const result = evalStrategy([trade({ side: 'sell', amountQuaiWei: 1n * QUAI, amountTokenWei: 10n * QUAI })]);
  assert.equal(result.realizedPnlWei, 0n);
  assert.equal(result.trades, 1);
});

// --- derivePaperPortfolioFromLedger ------------------------------------------------------------

test('sim: derivePaperPortfolioFromLedger computes cash as deposits - buys + sells - gas', () => {
  const ledger = {
    totalDepositedWei: (1000n * QUAI).toString(),
    gasSpentWei: (1n * QUAI).toString(),
    positions: { [TOKEN]: { symbol: 'X', amountWei: (50n * QUAI).toString(), avgCostQuaiWei: (10n * QUAI).toString() } },
    trades: [
      { side: 'buy', amountQuaiWei: (100n * QUAI).toString() },
      { side: 'sell', amountQuaiWei: (30n * QUAI).toString() },
    ],
  };
  const result = derivePaperPortfolioFromLedger(ledger);
  // 1000 - 100 + 30 - 1 (gas) = 929
  assert.equal(result.quaiWei, 929n * QUAI);
  assert.equal(result.positions[TOKEN], 50n * QUAI);
});

test('sim: derivePaperPortfolioFromLedger can exclude gas from the cash calculation', () => {
  const ledger = { totalDepositedWei: (10n * QUAI).toString(), gasSpentWei: (5n * QUAI).toString(), positions: {}, trades: [] };
  const result = derivePaperPortfolioFromLedger(ledger, { includeGas: false });
  assert.equal(result.quaiWei, 10n * QUAI);
});

test('sim: derivePaperPortfolioFromLedger handles an empty/fresh ledger', () => {
  const result = derivePaperPortfolioFromLedger({ totalDepositedWei: '0', gasSpentWei: '0', positions: {}, trades: [] });
  assert.equal(result.quaiWei, 0n);
  assert.deepEqual(result.positions, {});
});

test('sim: derivePaperPortfolioFromLedger omits a fully-closed (zero-amount) position', () => {
  const ledger = { totalDepositedWei: '0', gasSpentWei: '0', positions: { [TOKEN]: { symbol: 'X', amountWei: '0', avgCostQuaiWei: '0' } }, trades: [] };
  const result = derivePaperPortfolioFromLedger(ledger);
  assert.equal(result.positions[TOKEN], undefined);
});
