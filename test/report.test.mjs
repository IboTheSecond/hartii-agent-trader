import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatQuai,
  shortAddress,
  txUrl,
  formatTradeMessage,
  formatHourlySummary,
  createReporter,
  sendTelegram,
  sendNtfy,
} from '../src/report/index.mjs';

const QUAI = 10n ** 18n;
const TOKEN = '0x000000000000000000000000000000000000aa';

async function neverCalledFetch() {
  throw new Error('unit test tried to reach the network — inject fetchImpl instead');
}

function fakeTrade(overrides = {}) {
  return {
    id: 't1',
    atMs: 1000,
    side: 'buy',
    token: TOKEN,
    symbol: 'DOGE_2',
    amountQuaiWei: (2n * QUAI).toString(),
    amountTokenWei: (400n * QUAI).toString(),
    priceQuaiPerTokenWei: (5n * 10n ** 15n).toString(),
    txHash: '0xabc123',
    gasWei: (1n * 10n ** 16n).toString(),
    reason: 'momentum breakout',
    paper: false,
    ...overrides,
  };
}

function fakeSnapshot(overrides = {}) {
  return {
    quaiWei: (10n * QUAI).toString(),
    totalValueWei: (15n * QUAI).toString(),
    holdings: [{ token: TOKEN, symbol: 'DOGE_2', amountWei: (400n * QUAI).toString(), markValueQuaiWei: (5n * QUAI).toString() }],
    recentTrades: [fakeTrade()],
    realizedPnlWei: (1n * QUAI).toString(),
    unrealizedPnlWei: (-1n * (QUAI / 2n)).toString(),
    gasSpentWei: (2n * 10n ** 16n).toString(),
    growthPct: 12.34,
    ...overrides,
  };
}

// --- pure formatters -----------------------------------------------------------------------

test('report: formatQuai renders trimmed decimal QUAI amounts including negatives', () => {
  assert.equal(formatQuai(1n * QUAI), '1');
  assert.equal(formatQuai(1500000000000000000n), '1.5');
  assert.equal(formatQuai(-1500000000000000000n), '-1.5');
  assert.equal(formatQuai(0n), '0');
  assert.equal(formatQuai(undefined), '0');
});

test('report: shortAddress truncates long hex addresses and leaves short strings alone', () => {
  assert.equal(shortAddress(TOKEN), '0x0000...00aa');
  assert.equal(shortAddress('short'), 'short');
});

test('report: txUrl builds a quaiscan link, or null with no hash', () => {
  assert.equal(txUrl('0xabc'), 'https://quaiscan.io/tx/0xabc');
  assert.equal(txUrl(null), null);
});

test('report: formatTradeMessage includes side, symbol, amounts, tx link, reason, balances, PnL — and is safe for underscores', () => {
  const text = formatTradeMessage(fakeTrade(), fakeSnapshot());
  assert.match(text, /BUY/);
  assert.match(text, /\$DOGE_2/); // underscore preserved literally — no markdown escaping applied
  assert.match(text, /2 QUAI in -> 400 DOGE_2 out/);
  assert.match(text, /tx: https:\/\/quaiscan\.io\/tx\/0xabc123/);
  assert.match(text, /why: momentum breakout/);
  assert.match(text, /vault QUAI: 10/);
  assert.match(text, /realized: \+1 QUAI/);
  assert.match(text, /unrealized: -0\.5 QUAI/);
  assert.match(text, /growth vs deposits: \+12\.34%/);
});

test('report: formatTradeMessage marks a paper trade instead of a tx link', () => {
  const text = formatTradeMessage(fakeTrade({ txHash: null, paper: true }), fakeSnapshot());
  assert.match(text, /\(paper trade\)/);
  assert.doesNotMatch(text, /tx: https/);
});

test('report: formatTradeMessage requires a trade', () => {
  assert.throws(() => formatTradeMessage(null, fakeSnapshot()), TypeError);
});

test('report: formatHourlySummary includes balances, recent trades and PnL', () => {
  const text = formatHourlySummary(fakeSnapshot());
  assert.match(text, /HOURLY SUMMARY/);
  assert.match(text, /vault QUAI: 10/);
  assert.match(text, /realized: \+1 QUAI/);
});

// --- network functions (fetchImpl always injected — no real network) -----------------------

test('report: sendTelegram posts to the bot API with no parse_mode (plain text, underscore-safe)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => '' };
  };
  await sendTelegram({ botToken: 'TOKEN123', chatId: '999' }, 'hello _world_', fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOKEN123/sendMessage');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, '999');
  assert.equal(body.text, 'hello _world_');
  assert.equal(body.parse_mode, undefined);
});

test('report: sendTelegram throws on a non-2xx response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => sendTelegram({ botToken: 'x', chatId: 'y' }, 'hi', fetchImpl), /401/);
});

test('report: sendNtfy posts the raw text as the request body', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  await sendNtfy('https://ntfy.sh/mytopic', 'hourly summary', fetchImpl);
  assert.equal(calls[0].url, 'https://ntfy.sh/mytopic');
  assert.equal(calls[0].init.body, 'hourly summary');
});

// --- createReporter --------------------------------------------------------------------------

test('report: createReporter#reportTrade sends via Telegram and ntfy when both are configured', async () => {
  const sent = [];
  const sendImpl = async (url) => {
    sent.push(url);
    return { ok: true, status: 200, text: async () => '' };
  };
  const reporter = createReporter(
    { telegram: { botToken: 'x', chatId: 'y' }, ntfyUrl: 'https://ntfy.sh/t' },
    { sendImpl, minIntervalMs: 0 },
  );
  await reporter.reportTrade(fakeTrade(), fakeSnapshot());
  assert.equal(sent.length, 2);
  assert.ok(sent.some((u) => u.includes('api.telegram.org')));
  assert.ok(sent.some((u) => u === 'https://ntfy.sh/t'));
});

test('report: createReporter sends nowhere when neither channel is configured, and never throws', async () => {
  const reporter = createReporter({}, { sendImpl: neverCalledFetch, minIntervalMs: 0 });
  await reporter.reportTrade(fakeTrade(), fakeSnapshot());
  await reporter.reportHourly(fakeSnapshot());
  await reporter.reportBlocked('kill switch');
});

test('report: createReporter swallows a send failure instead of rejecting the caller', async () => {
  const errors = [];
  const reporter = createReporter(
    { telegram: { botToken: 'x', chatId: 'y' } },
    { sendImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }), minIntervalMs: 0, onError: (err, ctx) => errors.push({ err, ctx }) },
  );
  await reporter.reportTrade(fakeTrade(), fakeSnapshot());
  assert.equal(errors.length, 1);
  assert.match(errors[0].ctx, /reportTrade/);
});

test('report: createReporter throttles consecutive sends at least minIntervalMs apart', async () => {
  // A fully virtual clock (shared by `now` and `sleepFn`) — using the real wall clock here would
  // make this test flaky by a fraction of a millisecond depending on real scheduling jitter
  // between the two internal `now()` calls the throttle makes.
  const timestamps = [];
  let clock = 0;
  const sendImpl = async () => {
    timestamps.push(clock);
    return { ok: true, status: 200, text: async () => '' };
  };
  const sleepFn = async (ms) => {
    clock += ms;
  };
  const reporter = createReporter(
    { telegram: { botToken: 'x', chatId: 'y' } },
    { sendImpl, minIntervalMs: 1000, sleepFn, now: () => clock, onError: () => {} },
  );
  await Promise.all([reporter.reportTrade(fakeTrade(), fakeSnapshot()), reporter.reportTrade(fakeTrade(), fakeSnapshot())]);
  assert.equal(timestamps.length, 2);
  assert.ok(timestamps[1] - timestamps[0] >= 1000, `expected >= 1000ms apart, got ${timestamps[1] - timestamps[0]}`);
});
