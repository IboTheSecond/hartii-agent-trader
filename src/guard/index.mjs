// src/guard — pure guard math, zero I/O. The actual trust boundary: every trade passes
// through these before src/chain ever builds calldata. Never trust a model's proposed
// size/slippage directly.
// Contract: see INTERFACES.md#src-guard.

function notImplemented(fn) {
  throw new Error(`src/guard: ${fn} not implemented — see INTERFACES.md`);
}

/** @returns {{ amountInWei: bigint, clipped: boolean }} */
export function clipBuyToPortfolioCap(amountInWei, { fullPortfolioQuaiWei, maxFractionBps = 4000 } = {}) {
  return notImplemented('clipBuyToPortfolioCap');
}

/** @returns {{ tokensInWei: bigint, clipped: boolean }} */
export function clipSellToPortfolioCap(tokensInWei, { valueOfProposedWei, fullPortfolioQuaiWei, maxFractionBps = 4000 } = {}) {
  return notImplemented('clipSellToPortfolioCap');
}

/** Rejects (does not clip) anything under minMultiple x estimated gas. @returns {{ ok: boolean, reason?: string }} */
export function enforceGasFloor(valueWei, { estimatedGasCostWei, minMultiple = 5 } = {}) {
  return notImplemented('enforceGasFloor');
}

/** @returns {{ ok: boolean, reason?: string }} */
export function enforcePriceImpact(priceImpactPct, { maxPct } = {}) {
  return notImplemented('enforcePriceImpact');
}

/** Rejects an unset or zero slippage floor outright — never silently defaults it. @returns {{ ok: boolean, reason?: string }} */
export function enforceSlippageFloor(minOutWei) {
  return notImplemented('enforceSlippageFloor');
}

/** @returns {{ ok: boolean, reason?: string }} */
export function enforceLaunchGate({ launchesEnabled, launchCountSession, lastLaunchAtMs, nowMs, minIntervalMs = 3600000, maxPerSession = 2, imageUrl, approvedImageUrls } = {}) {
  return notImplemented('enforceLaunchGate');
}

/**
 * Always returns { ok: false }. NFT deploys are never allowed through this harness — no config
 * flag changes this return value.
 * @returns {{ ok: false, reason: string }}
 */
export function blockNftDeploys() {
  return { ok: false, reason: 'nft deploys are never permitted' };
}

/** @returns {{ ok: boolean, reason?: string }} */
export function enforceActionsPerCycle(actionsSoFar, maxPerCycle) {
  return notImplemented('enforceActionsPerCycle');
}

/** @returns {Promise<boolean>} */
export async function checkKillSwitch(killSwitchFile, existsImpl) {
  return notImplemented('checkKillSwitch');
}

/** @returns {{ ok: boolean, reason?: string }} */
export function enforceGasReserve(gasQuaiWei, thresholdWei) {
  return notImplemented('enforceGasReserve');
}

/**
 * Composition entry point used by src/tools' guarded hartii_buy handler.
 * @returns {{ ok: true, clipped: boolean, reason?: string, amountInWei: bigint } | { ok: false, reason: string }}
 */
export function guardBuy(args, ctx) {
  return notImplemented('guardBuy');
}

/**
 * Composition entry point used by src/tools' guarded hartii_sell handler.
 * @returns {{ ok: true, clipped: boolean, reason?: string, tokensInWei: bigint } | { ok: false, reason: string }}
 */
export function guardSell(args, ctx) {
  return notImplemented('guardSell');
}
