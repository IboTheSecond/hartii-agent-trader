import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTradeMessage, formatHourlySummary, createReporter, sendTelegram } from '../src/report/index.mjs';

// Placeholder scaffold test — replace with real coverage once src/report is implemented.
// Every test must inject a fake sendImpl/fetchImpl; never hit the real Telegram API from
// `node --test`.

async function neverCalledFetch() {
  throw new Error('unit test tried to reach the network — inject fetchImpl instead');
}

test('report: formatTradeMessage is a stub — throws not implemented until built', () => {
  assert.throws(() => formatTradeMessage({}, {}), /not implemented/);
});

test('report: formatHourlySummary is a stub — throws not implemented until built', () => {
  assert.throws(() => formatHourlySummary({}), /not implemented/);
});

test('report: createReporter methods are stubs — throw not implemented until built', async () => {
  const reporter = createReporter({ telegram: { botToken: 'x', chatId: 'y' } }, { sendImpl: neverCalledFetch });
  await assert.rejects(() => reporter.reportTrade({}, {}), /not implemented/);
});

test('report: sendTelegram is a stub — throws not implemented until built (no network)', async () => {
  await assert.rejects(
    () => sendTelegram({ botToken: 'x', chatId: 'y' }, 'hi', neverCalledFetch),
    /not implemented/,
  );
});
