// src/guard — pure guard math, zero I/O. The actual trust boundary: every trade passes
// through these before src/chain ever builds calldata. Never trust a model's proposed
// size/slippage directly.
// Contract: see INTERFACES.md#src-guard.

import { access } from 'node:fs/promises';

const BPS_DENOMINATOR = 10000n;

function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (v === undefined || v === null || v === '') return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

function fractionOf(baseWei, fractionBps) {
  return (toBig(baseWei) * BigInt(fractionBps)) / BPS_DENOMINATOR;
}

/** Clips (never rejects) a buy to maxFractionBps of full portfolio value. @returns {{ amountInWei: bigint, clipped: boolean }} */
export function clipBuyToPortfolioCap(amountInWei, { fullPortfolioQuaiWei, maxFractionBps = 4000 } = {}) {
  const amount = toBig(amountInWei);
  const cap = fractionOf(fullPortfolioQuaiWei, maxFractionBps);
  if (amount > cap) return { amountInWei: cap, clipped: true };
  return { amountInWei: amount, clipped: false };
}

/** Clips a sell the same way, using the quoted QUAI value of the tokens being sold. @returns {{ tokensInWei: bigint, clipped: boolean }} */
export function clipSellToPortfolioCap(tokensInWei, { valueOfProposedWei, fullPortfolioQuaiWei, maxFractionBps = 4000 } = {}) {
  const tokens = toBig(tokensInWei);
  const value = toBig(valueOfProposedWei);
  const cap = fractionOf(fullPortfolioQuaiWei, maxFractionBps);
  if (value > cap && value > 0n) {
    return { tokensInWei: (tokens * cap) / value, clipped: true };
  }
  return { tokensInWei: tokens, clipped: false };
}

/** Rejects (does not clip) anything under minMultiple x estimated gas. @returns {{ ok: boolean, reason?: string }} */
export function enforceGasFloor(valueWei, { estimatedGasCostWei, minMultiple = 5 } = {}) {
  const value = toBig(valueWei);
  const floor = toBig(estimatedGasCostWei) * BigInt(minMultiple);
  if (value < floor) {
    return { ok: false, reason: `below the minimum trade size (${minMultiple}x estimated gas = ${floor.toString()} wei)` };
  }
  return { ok: true };
}

/** @returns {{ ok: boolean, reason?: string }} */
export function enforcePriceImpact(priceImpactPct, { maxPct } = {}) {
  if (typeof maxPct !== 'number' || !Number.isFinite(maxPct)) {
    return { ok: false, reason: 'no price impact ceiling configured' };
  }
  if (typeof priceImpactPct !== 'number' || !Number.isFinite(priceImpactPct)) {
    return { ok: false, reason: 'price impact is not a finite number' };
  }
  if (priceImpactPct > maxPct) {
    return { ok: false, reason: `price impact ${priceImpactPct}% exceeds the ${maxPct}% ceiling` };
  }
  return { ok: true };
}

// SECURITY (see the security fix this closes): the max drift, in bps, this harness tolerates
// between the live quote a trade's guard checks were computed from and the actual on-chain/paper
// fill, on TOP OF (never instead of) requiring a set, positive minOut. Without this, a decider
// could clear enforceSlippageFloor with a technically-positive but effectively-unprotected minOut
// (e.g. "1") — the price-impact ceiling only bounds the QUOTED price vs. spot, not how far price
// may move between that quote and execution.
export const DEFAULT_MAX_SLIPPAGE_BPS = 500; // 5%

/**
 * Rejects an unset or zero slippage floor outright — never silently defaults it. When
 * `quotedAmountOutWei` is also given (the live quote this trade's other guard checks were
 * computed from), ALSO rejects a minOut below a code-derived floor
 * (`quotedAmountOutWei * (1 - maxSlippageBps/10000)`), so a model can no longer satisfy this
 * guard by proposing a merely-nonzero minOut — the floor itself is code-enforced, never left to
 * whatever value the model happened to propose.
 * @param {bigint | string | undefined | null} minOutWei
 * @param {{ quotedAmountOutWei?: bigint, maxSlippageBps?: number }} [ctx]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function enforceSlippageFloor(minOutWei, { quotedAmountOutWei, maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS } = {}) {
  if (minOutWei === undefined || minOutWei === null) {
    return { ok: false, reason: 'slippage floor (minOut) is unset' };
  }
  const minOut = toBig(minOutWei);
  if (minOut <= 0n) {
    return { ok: false, reason: 'slippage floor (minOut) must be greater than zero' };
  }
  if (quotedAmountOutWei !== undefined && quotedAmountOutWei !== null) {
    const quoted = toBig(quotedAmountOutWei);
    if (quoted > 0n) {
      const codeFloor = (quoted * BigInt(10000 - maxSlippageBps)) / 10000n;
      if (minOut < codeFloor) {
        return {
          ok: false,
          reason: `slippage floor (minOut=${minOut.toString()}) is below the code-enforced ${maxSlippageBps / 100}% max-slippage floor (${codeFloor.toString()} wei, off a quoted ${quoted.toString()} wei) — a model-proposed minOut is never trusted on its own`,
        };
      }
    }
  }
  return { ok: true };
}

/** @returns {{ ok: boolean, reason?: string }} */
export function enforceLaunchGate({
  launchesEnabled,
  launchCountSession,
  lastLaunchAtMs,
  nowMs,
  minIntervalMs = 3600000,
  maxPerSession = 2,
  imageUrl,
  approvedImageUrls,
} = {}) {
  if (!launchesEnabled) {
    return { ok: false, reason: 'launches are disabled (HARTII_LAUNCHES_ENABLED is not set)' };
  }
  if ((launchCountSession ?? 0) >= maxPerSession) {
    return { ok: false, reason: `max ${maxPerSession} launches per session already reached` };
  }
  if (lastLaunchAtMs !== null && lastLaunchAtMs !== undefined && nowMs - lastLaunchAtMs < minIntervalMs) {
    const waitMinutes = Math.ceil((minIntervalMs - (nowMs - lastLaunchAtMs)) / 60000);
    return { ok: false, reason: `must wait ~${waitMinutes} more minute(s) since the last launch (>= ${Math.round(minIntervalMs / 60000)} min apart)` };
  }
  if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
    return { ok: false, reason: 'image URL is required' };
  }
  const pool = Array.isArray(approvedImageUrls) ? approvedImageUrls : [];
  if (!pool.includes(imageUrl)) {
    return { ok: false, reason: 'image URL is not in the owner-approved pool' };
  }
  return { ok: true };
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
  if (actionsSoFar >= maxPerCycle) {
    return { ok: false, reason: `max ${maxPerCycle} actions per cycle already reached` };
  }
  return { ok: true };
}

async function defaultFileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<boolean>} */
export async function checkKillSwitch(killSwitchFile, existsImpl = defaultFileExists) {
  return Boolean(await existsImpl(killSwitchFile));
}

/** @returns {{ ok: boolean, reason?: string }} */
export function enforceGasReserve(gasQuaiWei, thresholdWei) {
  const gas = toBig(gasQuaiWei);
  const threshold = toBig(thresholdWei);
  if (gas < threshold) {
    return { ok: false, reason: `gas balance (${gas.toString()} wei) is below the reserve threshold (${threshold.toString()} wei)` };
  }
  return { ok: true };
}

/**
 * Composition entry point used by src/tools' guarded hartii_buy handler. Mirrors the checked
 * order of a proven prior implementation: reject on bad slippage/impact input first, reject if
 * the FULL portfolio can't even fund the minimum (5x-gas) trade, reject if the model's own
 * proposed size is itself under that floor, and only THEN clip an oversized proposal down to the
 * portfolio cap — clipping never needs to re-check the floor because cap >= floor was already
 * confirmed by that point.
 * @returns {{ ok: true, clipped: boolean, reason?: string, amountInWei: bigint } | { ok: false, reason: string }}
 */
export function guardBuy(args, ctx) {
  const proposed = toBig(args.amountInWei);
  if (proposed <= 0n) return { ok: false, reason: 'zero or negative amount' };

  const slippage = enforceSlippageFloor(args.minTokensOutWei, {
    quotedAmountOutWei: ctx.quotedAmountOutWei,
    maxSlippageBps: ctx.maxSlippageBps,
  });
  if (!slippage.ok) return slippage;

  const impact = enforcePriceImpact(args.priceImpactPct, { maxPct: ctx.maxPriceImpactPct });
  if (!impact.ok) return impact;

  const maxFractionBps = ctx.maxFractionBps ?? 4000;
  const cap = fractionOf(ctx.fullPortfolioQuaiWei, maxFractionBps);
  const portfolioFloor = enforceGasFloor(cap, { estimatedGasCostWei: ctx.estimatedGasCostWei });
  if (!portfolioFloor.ok) {
    return { ok: false, reason: `portfolio too small right now to fund even the minimum trade size (${portfolioFloor.reason})` };
  }

  const proposedFloor = enforceGasFloor(proposed, { estimatedGasCostWei: ctx.estimatedGasCostWei });
  if (!proposedFloor.ok) return proposedFloor;

  const clip = clipBuyToPortfolioCap(proposed, { fullPortfolioQuaiWei: ctx.fullPortfolioQuaiWei, maxFractionBps });
  return {
    ok: true,
    clipped: clip.clipped,
    amountInWei: clip.amountInWei,
    ...(clip.clipped ? { reason: `clipped to ${maxFractionBps / 100}% of full portfolio (${cap.toString()} wei)` } : {}),
  };
}

/**
 * Composition entry point used by src/tools' guarded hartii_sell handler. `ctx.valueOfProposedWei`
 * (a live sell quote for the model's FULL proposed `args.tokensInWei`, fetched by the caller —
 * this module does no I/O) stands in for "amount" everywhere the buy side uses QUAI directly.
 * @returns {{ ok: true, clipped: boolean, reason?: string, tokensInWei: bigint } | { ok: false, reason: string }}
 */
export function guardSell(args, ctx) {
  const tokens = toBig(args.tokensInWei);
  const value = toBig(args.valueOfProposedWei ?? ctx.valueOfProposedWei);
  if (tokens <= 0n) return { ok: false, reason: 'zero or negative amount' };
  if (value <= 0n) return { ok: false, reason: 'sell quote returned no value — refusing to guess a size' };

  // `value` (args.valueOfProposedWei ?? ctx.valueOfProposedWei) IS the live sell quote's QUAI-out
  // for the full proposed tokensInWei — exactly the "quotedAmountOutWei" this trade's other guard
  // checks were computed from, so it doubles as the slippage floor's quote reference too.
  const slippage = enforceSlippageFloor(args.minQuaiOutWei, { quotedAmountOutWei: value, maxSlippageBps: ctx.maxSlippageBps });
  if (!slippage.ok) return slippage;

  const impact = enforcePriceImpact(args.priceImpactPct, { maxPct: ctx.maxPriceImpactPct });
  if (!impact.ok) return impact;

  const maxFractionBps = ctx.maxFractionBps ?? 4000;
  const cap = fractionOf(ctx.fullPortfolioQuaiWei, maxFractionBps);
  const portfolioFloor = enforceGasFloor(cap, { estimatedGasCostWei: ctx.estimatedGasCostWei });
  if (!portfolioFloor.ok) {
    return { ok: false, reason: `portfolio too small right now to fund even the minimum trade size (${portfolioFloor.reason})` };
  }

  const valueFloor = enforceGasFloor(value, { estimatedGasCostWei: ctx.estimatedGasCostWei });
  if (!valueFloor.ok) return valueFloor;

  const clip = clipSellToPortfolioCap(tokens, { valueOfProposedWei: value, fullPortfolioQuaiWei: ctx.fullPortfolioQuaiWei, maxFractionBps });
  return {
    ok: true,
    clipped: clip.clipped,
    tokensInWei: clip.tokensInWei,
    ...(clip.clipped ? { reason: `clipped to ${maxFractionBps / 100}% of full portfolio (${cap.toString()} wei)` } : {}),
  };
}
