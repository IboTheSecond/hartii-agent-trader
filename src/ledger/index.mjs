// src/ledger — trade ledger, average-cost realised/unrealised PnL, deposits (tracked
// separately so top-ups never inflate PnL), gas accounting.
// Contract + on-disk schema: see INTERFACES.md#src-ledger.

function notImplemented(fn) {
  throw new Error(`src/ledger: ${fn} not implemented — see INTERFACES.md`);
}

export const LEDGER_SCHEMA_VERSION = 1;

/** @returns {object} an empty Ledger matching the schema in INTERFACES.md */
export function createLedger() {
  return notImplemented('createLedger');
}

/** @returns {object} Ledger */
export function recordDeposit(ledger, { amountWei, atMs, txHash } = {}) {
  return notImplemented('recordDeposit');
}

/**
 * buy: adds to the position at average cost. sell: realizes PnL against the position's
 * average cost for the portion sold; throws if selling more than the tracked position.
 * @returns {object} Ledger
 */
export function recordTrade(ledger, trade) {
  return notImplemented('recordTrade');
}

/** @returns {object} Ledger */
export function recordGas(ledger, { gasWei, atMs, txHash } = {}) {
  return notImplemented('recordGas');
}

/** @returns {bigint} */
export function getRealizedPnlWei(ledger) {
  return notImplemented('getRealizedPnlWei');
}

/** @returns {bigint} */
export function getUnrealizedPnlWei(ledger, markPricesWeiByToken) {
  return notImplemented('getUnrealizedPnlWei');
}

/** @returns {number} (currentPortfolioQuaiWei - totalDepositedWei) / totalDepositedWei * 100 */
export function getGrowthPct(ledger, currentPortfolioQuaiWei) {
  return notImplemented('getGrowthPct');
}

/** @returns {object[]} TradeRecord[] */
export function getRecentTrades(ledger, n = 5) {
  return notImplemented('getRecentTrades');
}

/** @returns {Promise<object>} Ledger — createLedger() if the file does not exist yet. */
export async function loadLedger(filePath, readImpl) {
  return notImplemented('loadLedger');
}

/** @returns {Promise<void>} */
export async function saveLedger(filePath, ledger, writeImpl) {
  return notImplemented('saveLedger');
}
