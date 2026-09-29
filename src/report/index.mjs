// src/report — Telegram (+ optional ntfy) formatting/sending/throttling. Plain text only,
// safe for underscores in token symbols (no unescaped Markdown).
// Contract: see INTERFACES.md#src-report.

function notImplemented(fn) {
  throw new Error(`src/report: ${fn} not implemented — see INTERFACES.md`);
}

/**
 * side, $SYMBOL + short address, QUAI in/out, tokens, price, tx link
 * https://quaiscan.io/tx/<hash> (or "(paper trade)"), one-line reason, current balances,
 * last ~5 trades, realized/unrealized PnL, gas spent, growth % vs deposits.
 * @param {object} trade TradeRecord
 * @param {object} snapshot PortfolioSnapshot
 * @returns {string}
 */
export function formatTradeMessage(trade, snapshot) {
  return notImplemented('formatTradeMessage');
}

/** @returns {string} */
export function formatHourlySummary(snapshot) {
  return notImplemented('formatHourlySummary');
}

/**
 * @param {object} config Config
 * @param {{ sendImpl?: Function }} [opts]
 */
export function createReporter(config, opts = {}) {
  return {
    /** @returns {Promise<void>} */
    async reportTrade(trade, snapshot) {
      return notImplemented('Reporter#reportTrade');
    },
    /** @returns {Promise<void>} */
    async reportHourly(snapshot) {
      return notImplemented('Reporter#reportHourly');
    },
    /** kill switch / paused / gas-low. @returns {Promise<void>} */
    async reportBlocked(reason) {
      return notImplemented('Reporter#reportBlocked');
    },
  };
}

/** @returns {Promise<void>} */
export async function sendTelegram({ botToken, chatId }, text, fetchImpl = fetch) {
  return notImplemented('sendTelegram');
}

/** @returns {Promise<void>} */
export async function sendNtfy(url, text, fetchImpl = fetch) {
  return notImplemented('sendNtfy');
}
