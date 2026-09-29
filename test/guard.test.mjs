import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../src/guard/index.mjs';

// Pure functions, zero I/O, no network — this module is the actual trust boundary, so it gets
// the heaviest coverage of any module in this repo.

test('guard: blockNftDeploys always refuses, unconditionally', () => {
  const decision = guard.blockNftDeploys();
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /never/);
});

// --- clipBuyToPortfolioCap -----------------------------------------------------------------

test('guard: clipBuyToPortfolioCap passes an amount under the cap through unchanged', () => {
  const result = guard.clipBuyToPortfolioCap(300n, { fullPortfolioQuaiWei: 1000n, maxFractionBps: 4000 });
  assert.equal(result.amountInWei, 300n);
  assert.equal(result.clipped, false);
});

test('guard: clipBuyToPortfolioCap clips (never rejects) an oversized amount to exactly the cap', () => {
  const result = guard.clipBuyToPortfolioCap(900n, { fullPortfolioQuaiWei: 1000n, maxFractionBps: 4000 });
  assert.equal(result.amountInWei, 400n); // 40% of 1000
  assert.equal(result.clipped, true);
});

test('guard: clipBuyToPortfolioCap defaults maxFractionBps to 4000 (40%)', () => {
  const result = guard.clipBuyToPortfolioCap(10000n, { fullPortfolioQuaiWei: 1000n });
  assert.equal(result.amountInWei, 400n);
});

// --- clipSellToPortfolioCap ----------------------------------------------------------------

test('guard: clipSellToPortfolioCap passes tokens through unchanged when the quoted value is under the cap', () => {
  const result = guard.clipSellToPortfolioCap(500n, { valueOfProposedWei: 300n, fullPortfolioQuaiWei: 1000n, maxFractionBps: 4000 });
  assert.equal(result.tokensInWei, 500n);
  assert.equal(result.clipped, false);
});

test('guard: clipSellToPortfolioCap proportionally clips tokens when the quoted value exceeds the cap', () => {
  // proposing to sell 1000 tokens worth 800 QUAI, cap is 400 QUAI (40% of 1000) -> clip to half
  const result = guard.clipSellToPortfolioCap(1000n, { valueOfProposedWei: 800n, fullPortfolioQuaiWei: 1000n, maxFractionBps: 4000 });
  assert.equal(result.tokensInWei, 500n);
  assert.equal(result.clipped, true);
});

// --- enforceGasFloor -------------------------------------------------------------------------

test('guard: enforceGasFloor rejects a value under 5x estimated gas by default', () => {
  const result = guard.enforceGasFloor(10n, { estimatedGasCostWei: 3n });
  assert.equal(result.ok, false);
  assert.match(result.reason, /5x estimated gas/);
});

test('guard: enforceGasFloor accepts a value at or above the floor', () => {
  assert.equal(guard.enforceGasFloor(15n, { estimatedGasCostWei: 3n }).ok, true);
  assert.equal(guard.enforceGasFloor(16n, { estimatedGasCostWei: 3n }).ok, true);
});

test('guard: enforceGasFloor respects a custom minMultiple', () => {
  assert.equal(guard.enforceGasFloor(20n, { estimatedGasCostWei: 3n, minMultiple: 10 }).ok, false);
  assert.equal(guard.enforceGasFloor(30n, { estimatedGasCostWei: 3n, minMultiple: 10 }).ok, true);
});

// --- enforcePriceImpact -----------------------------------------------------------------------

test('guard: enforcePriceImpact accepts impact at or under the ceiling', () => {
  assert.equal(guard.enforcePriceImpact(8, { maxPct: 8 }).ok, true);
  assert.equal(guard.enforcePriceImpact(4, { maxPct: 8 }).ok, true);
});

test('guard: enforcePriceImpact rejects impact over the ceiling', () => {
  const result = guard.enforcePriceImpact(9, { maxPct: 8 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /8%/);
});

test('guard: enforcePriceImpact fails closed when maxPct is missing/misconfigured', () => {
  assert.equal(guard.enforcePriceImpact(1, {}).ok, false);
  assert.equal(guard.enforcePriceImpact(1, { maxPct: NaN }).ok, false);
});

// --- enforceSlippageFloor ---------------------------------------------------------------------

test('guard: enforceSlippageFloor rejects unset (undefined/null) outright', () => {
  assert.equal(guard.enforceSlippageFloor(undefined).ok, false);
  assert.equal(guard.enforceSlippageFloor(null).ok, false);
});

test('guard: enforceSlippageFloor rejects zero — never silently defaults it', () => {
  assert.equal(guard.enforceSlippageFloor(0n).ok, false);
});

test('guard: enforceSlippageFloor accepts any positive floor', () => {
  assert.equal(guard.enforceSlippageFloor(1n).ok, true);
});

// --- enforceLaunchGate -------------------------------------------------------------------------

const baseLaunchArgs = () => ({
  launchesEnabled: true,
  launchCountSession: 0,
  lastLaunchAtMs: null,
  nowMs: 1_000_000_000,
  imageUrl: 'https://higgsfield.ai/logo.png',
  approvedImageUrls: ['https://higgsfield.ai/logo.png'],
});

test('guard: enforceLaunchGate rejects when launches are disabled', () => {
  const result = guard.enforceLaunchGate({ ...baseLaunchArgs(), launchesEnabled: false });
  assert.equal(result.ok, false);
});

test('guard: enforceLaunchGate rejects once the per-session max is reached', () => {
  const result = guard.enforceLaunchGate({ ...baseLaunchArgs(), launchCountSession: 2, maxPerSession: 2 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /2 launches/);
});

test('guard: enforceLaunchGate rejects when the minimum interval since the last launch has not passed', () => {
  const result = guard.enforceLaunchGate({
    ...baseLaunchArgs(),
    lastLaunchAtMs: 1_000_000_000 - 60_000,
    nowMs: 1_000_000_000,
    minIntervalMs: 3_600_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /wait/);
});

test('guard: enforceLaunchGate rejects an image URL outside the approved pool', () => {
  const result = guard.enforceLaunchGate({ ...baseLaunchArgs(), imageUrl: 'https://evil.example/logo.png' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /approved pool/);
});

test('guard: enforceLaunchGate accepts a compliant launch', () => {
  const result = guard.enforceLaunchGate(baseLaunchArgs());
  assert.equal(result.ok, true);
});

// --- enforceActionsPerCycle -------------------------------------------------------------------

test('guard: enforceActionsPerCycle allows actions under the cap and rejects at/over it', () => {
  assert.equal(guard.enforceActionsPerCycle(0, 3).ok, true);
  assert.equal(guard.enforceActionsPerCycle(2, 3).ok, true);
  assert.equal(guard.enforceActionsPerCycle(3, 3).ok, false);
  assert.equal(guard.enforceActionsPerCycle(4, 3).ok, false);
});

// --- checkKillSwitch ----------------------------------------------------------------------------

test('guard: checkKillSwitch reflects the injected existsImpl', async () => {
  assert.equal(await guard.checkKillSwitch('state/STOP', async () => true), true);
  assert.equal(await guard.checkKillSwitch('state/STOP', async () => false), false);
});

test('guard: checkKillSwitch defaults to a real filesystem check when no existsImpl is given', async () => {
  assert.equal(await guard.checkKillSwitch('definitely-does-not-exist/STOP'), false);
});

// --- enforceGasReserve ----------------------------------------------------------------------------

test('guard: enforceGasReserve rejects below threshold, accepts at/above it', () => {
  assert.equal(guard.enforceGasReserve(5n, 10n).ok, false);
  assert.equal(guard.enforceGasReserve(10n, 10n).ok, true);
  assert.equal(guard.enforceGasReserve(11n, 10n).ok, true);
});

// --- guardBuy (composition entry point) ---------------------------------------------------------

function buyCtx(overrides = {}) {
  return {
    fullPortfolioQuaiWei: 1000n,
    estimatedGasCostWei: 3n,
    maxPriceImpactPct: 8,
    maxFractionBps: 4000,
    ...overrides,
  };
}

test('guardBuy: rejects a zero/negative proposed amount', () => {
  const result = guard.guardBuy({ amountInWei: 0n, minTokensOutWei: 1n, priceImpactPct: 1 }, buyCtx());
  assert.equal(result.ok, false);
});

test('guardBuy: rejects an unset slippage floor even for an otherwise-valid buy', () => {
  const result = guard.guardBuy({ amountInWei: 100n, minTokensOutWei: undefined, priceImpactPct: 1 }, buyCtx());
  assert.equal(result.ok, false);
  assert.match(result.reason, /slippage/);
});

test('guardBuy: rejects when price impact exceeds the ceiling', () => {
  const result = guard.guardBuy({ amountInWei: 100n, minTokensOutWei: 1n, priceImpactPct: 20 }, buyCtx());
  assert.equal(result.ok, false);
});

test('guardBuy: rejects a proposed size below the 5x-gas floor even though the portfolio could fund more', () => {
  const result = guard.guardBuy({ amountInWei: 2n, minTokensOutWei: 1n, priceImpactPct: 1 }, buyCtx());
  assert.equal(result.ok, false);
  assert.match(result.reason, /minimum trade size/);
});

test('guardBuy: rejects outright when the whole portfolio is too small to fund even the minimum trade', () => {
  const result = guard.guardBuy({ amountInWei: 10n, minTokensOutWei: 1n, priceImpactPct: 1 }, buyCtx({ fullPortfolioQuaiWei: 20n, estimatedGasCostWei: 10n }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /portfolio too small/);
});

test('guardBuy: passes a compliant, in-range size through unclipped', () => {
  const result = guard.guardBuy({ amountInWei: 200n, minTokensOutWei: 1n, priceImpactPct: 1 }, buyCtx());
  assert.equal(result.ok, true);
  assert.equal(result.clipped, false);
  assert.equal(result.amountInWei, 200n);
});

test('guardBuy: clips (never rejects) an oversized proposal down to the portfolio cap', () => {
  const result = guard.guardBuy({ amountInWei: 900n, minTokensOutWei: 1n, priceImpactPct: 1 }, buyCtx());
  assert.equal(result.ok, true);
  assert.equal(result.clipped, true);
  assert.equal(result.amountInWei, 400n); // 40% of 1000
  assert.match(result.reason, /clipped/);
});

// --- guardSell (composition entry point) --------------------------------------------------------

function sellCtx(overrides = {}) {
  return {
    fullPortfolioQuaiWei: 1000n,
    estimatedGasCostWei: 3n,
    maxPriceImpactPct: 8,
    maxFractionBps: 4000,
    ...overrides,
  };
}

test('guardSell: rejects a zero/negative token amount', () => {
  const result = guard.guardSell({ tokensInWei: 0n, minQuaiOutWei: 1n, priceImpactPct: 1, valueOfProposedWei: 100n }, sellCtx());
  assert.equal(result.ok, false);
});

test('guardSell: rejects when the sell quote returned no value, refusing to guess a size', () => {
  const result = guard.guardSell({ tokensInWei: 100n, minQuaiOutWei: 1n, priceImpactPct: 1, valueOfProposedWei: 0n }, sellCtx());
  assert.equal(result.ok, false);
  assert.match(result.reason, /refusing to guess/);
});

test('guardSell: rejects an unset slippage floor', () => {
  const result = guard.guardSell({ tokensInWei: 100n, minQuaiOutWei: null, priceImpactPct: 1, valueOfProposedWei: 100n }, sellCtx());
  assert.equal(result.ok, false);
  assert.match(result.reason, /slippage/);
});

test('guardSell: passes a compliant sell through unclipped', () => {
  const result = guard.guardSell({ tokensInWei: 500n, minQuaiOutWei: 1n, priceImpactPct: 1, valueOfProposedWei: 300n }, sellCtx());
  assert.equal(result.ok, true);
  assert.equal(result.clipped, false);
  assert.equal(result.tokensInWei, 500n);
});

test('guardSell: proportionally clips an oversized sell to the portfolio cap by value', () => {
  const result = guard.guardSell({ tokensInWei: 1000n, minQuaiOutWei: 1n, priceImpactPct: 1, valueOfProposedWei: 800n }, sellCtx());
  assert.equal(result.ok, true);
  assert.equal(result.clipped, true);
  assert.equal(result.tokensInWei, 500n); // cap is 400/800 of the proposed value -> half the tokens
});
