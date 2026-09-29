// src/ledger — trade ledger, average-cost realised/unrealised PnL, deposits (tracked
// separately so top-ups never inflate PnL), gas accounting.
// Contract + on-disk schema: see INTERFACES.md#src-ledger.
//
// The Ledger object is always plain-JSON-safe (every wei amount stored as a decimal STRING,
// never a bigint) since it IS the on-disk / status.json boundary — see INTERFACES.md's
// cross-cutting rule "convert at the boundary, never in the middle". recordDeposit/recordGas
// accept bigint (fresh amounts a caller just read from src/chain) and serialize them on the way
// in; recordTrade accepts a TradeRecord already in its on-disk (string) shape, since a
// TradeRecord is itself the JSON-boundary type shared with src/report. The get*PnlWei /
// getGrowthPct readers convert the stored strings back to bigint/number on the way out.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const LEDGER_SCHEMA_VERSION = 1;

const WEI_SCALE = 10n ** 18n; // fixed-point scale for avgCostQuaiWei / priceQuaiPerTokenWei —
// both represent "QUAI wei per 1e18 token-wei" (i.e. per one whole 18-decimal token), not a
// per-wei price, so that a price stays representable as an integer even for tokens whose supply
// dwarfs the QUAI raised for them.

function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (v === undefined || v === null || v === '') return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

function divSafe(numerator, denominator) {
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

/** @returns {object} an empty Ledger matching the schema in INTERFACES.md */
export function createLedger() {
  return {
    version: LEDGER_SCHEMA_VERSION,
    totalDepositedWei: '0',
    realizedPnlWei: '0',
    gasSpentWei: '0',
    positions: {},
    trades: [],
    deposits: [],
  };
}

/** Fills in any missing top-level field (e.g. an older/hand-built fixture) against a fresh ledger. */
function normalizeLedger(ledger) {
  const base = createLedger();
  if (!ledger || typeof ledger !== 'object') return base;
  return {
    version: LEDGER_SCHEMA_VERSION,
    totalDepositedWei: typeof ledger.totalDepositedWei === 'string' ? ledger.totalDepositedWei : base.totalDepositedWei,
    realizedPnlWei: typeof ledger.realizedPnlWei === 'string' ? ledger.realizedPnlWei : base.realizedPnlWei,
    gasSpentWei: typeof ledger.gasSpentWei === 'string' ? ledger.gasSpentWei : base.gasSpentWei,
    positions: ledger.positions && typeof ledger.positions === 'object' ? ledger.positions : base.positions,
    trades: Array.isArray(ledger.trades) ? ledger.trades : base.trades,
    deposits: Array.isArray(ledger.deposits) ? ledger.deposits : base.deposits,
  };
}

/** @returns {object} Ledger */
export function recordDeposit(ledger, { amountWei, atMs, txHash = null } = {}) {
  const base = normalizeLedger(ledger);
  const amount = toBig(amountWei);
  return {
    ...base,
    totalDepositedWei: (toBig(base.totalDepositedWei) + amount).toString(),
    deposits: [...base.deposits, { amountWei: amount.toString(), atMs, txHash }],
  };
}

/**
 * buy: adds to the position at average cost. sell: realizes PnL against the position's
 * average cost for the portion sold; throws if selling more than the tracked position.
 * @returns {object} Ledger
 */
export function recordTrade(ledger, trade) {
  const base = normalizeLedger(ledger);
  const positions = { ...base.positions };
  const key = trade.token;
  const prior = positions[key] || { symbol: trade.symbol || '', amountWei: '0', avgCostQuaiWei: '0' };

  const priorAmount = toBig(prior.amountWei);
  const priorAvgCost = toBig(prior.avgCostQuaiWei);
  const tradeQuai = toBig(trade.amountQuaiWei);
  const tradeTokens = toBig(trade.amountTokenWei);

  let nextAmount;
  let nextAvgCost;
  let realizedDelta = 0n;

  if (trade.side === 'buy') {
    const priorCostBasis = divSafe(priorAmount * priorAvgCost, WEI_SCALE);
    nextAmount = priorAmount + tradeTokens;
    const nextCostBasis = priorCostBasis + tradeQuai;
    nextAvgCost = nextAmount === 0n ? 0n : divSafe(nextCostBasis * WEI_SCALE, nextAmount);
  } else if (trade.side === 'sell') {
    if (tradeTokens > priorAmount) {
      throw new Error(
        `src/ledger#recordTrade: cannot sell ${tradeTokens.toString()} wei of ${key}, only ${priorAmount.toString()} wei held`,
      );
    }
    const soldCostBasis = divSafe(priorAvgCost * tradeTokens, WEI_SCALE);
    realizedDelta = tradeQuai - soldCostBasis;
    nextAmount = priorAmount - tradeTokens;
    nextAvgCost = priorAvgCost; // average cost of whatever remains is unchanged by a sell
  } else {
    throw new Error(`src/ledger#recordTrade: unknown trade side "${trade.side}"`);
  }

  if (nextAmount === 0n) {
    delete positions[key];
  } else {
    positions[key] = { symbol: prior.symbol || trade.symbol || '', amountWei: nextAmount.toString(), avgCostQuaiWei: nextAvgCost.toString() };
  }

  return {
    ...base,
    realizedPnlWei: (toBig(base.realizedPnlWei) + realizedDelta).toString(),
    gasSpentWei: (toBig(base.gasSpentWei) + toBig(trade.gasWei)).toString(),
    positions,
    trades: [...base.trades, trade],
  };
}

/** @returns {object} Ledger */
export function recordGas(ledger, { gasWei, atMs, txHash } = {}) {
  const base = normalizeLedger(ledger);
  void atMs;
  void txHash; // no separate gas log array in the schema — gasSpentWei is the running total;
  // per-trade gas is separately visible on each TradeRecord.gasWei already in `trades`.
  return {
    ...base,
    gasSpentWei: (toBig(base.gasSpentWei) + toBig(gasWei)).toString(),
  };
}

/** @returns {bigint} */
export function getRealizedPnlWei(ledger) {
  return toBig(ledger?.realizedPnlWei);
}

/** @returns {bigint} */
export function getUnrealizedPnlWei(ledger, markPricesWeiByToken = {}) {
  let total = 0n;
  for (const [token, pos] of Object.entries(ledger?.positions || {})) {
    const mark = markPricesWeiByToken?.[token];
    if (mark === undefined || mark === null) continue; // no live mark for this token — skip rather than guess
    const amount = toBig(pos.amountWei);
    const markValue = divSafe(amount * toBig(mark), WEI_SCALE);
    const costValue = divSafe(amount * toBig(pos.avgCostQuaiWei), WEI_SCALE);
    total += markValue - costValue;
  }
  return total;
}

/** @returns {number} (currentPortfolioQuaiWei - totalDepositedWei) / totalDepositedWei * 100 */
export function getGrowthPct(ledger, currentPortfolioQuaiWei) {
  const deposited = toBig(ledger?.totalDepositedWei);
  if (deposited === 0n) return 0;
  const current = toBig(currentPortfolioQuaiWei);
  // bigint math scaled by 1e6 for four decimal places of precision in the final percentage,
  // then dropped down to a plain JS number only at the very end (never mid-computation).
  const scaled = ((current - deposited) * 1000000n) / deposited;
  return Number(scaled) / 10000;
}

/** @returns {object[]} TradeRecord[], most-recent-first */
export function getRecentTrades(ledger, n = 5) {
  const trades = ledger?.trades || [];
  return trades.slice(-n).reverse();
}

async function defaultReadFile(filePath) {
  return readFile(filePath, 'utf8');
}

async function defaultAtomicWrite(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmpPath, contents, 'utf8');
  await rename(tmpPath, filePath);
}

/** @returns {Promise<object>} Ledger — createLedger() if the file does not exist yet. */
export async function loadLedger(filePath, readImpl = defaultReadFile) {
  let raw;
  try {
    raw = await readImpl(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return createLedger();
    throw err;
  }
  return normalizeLedger(JSON.parse(raw));
}

/** @returns {Promise<void>} */
export async function saveLedger(filePath, ledger, writeImpl = defaultAtomicWrite) {
  await writeImpl(filePath, JSON.stringify(ledger, null, 2));
}
