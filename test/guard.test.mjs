import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../src/guard/index.mjs';

// Placeholder scaffold test — replace with real coverage (pure functions, no I/O, no network)
// once src/guard is implemented. This module is the actual trust boundary — give it the
// heaviest real test coverage of any module once it's built (40% clip, 5x gas floor, price
// impact, slippage floor, launch gate, kill switch, actions-per-cycle, gas reserve).

test('guard: blockNftDeploys always refuses, unconditionally, and is already implemented', () => {
  const decision = guard.blockNftDeploys();
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /never/);
});

test('guard: clipBuyToPortfolioCap is a stub — throws not implemented until built', () => {
  assert.throws(
    () => guard.clipBuyToPortfolioCap(100n, { fullPortfolioQuaiWei: 1000n }),
    /not implemented/,
  );
});

test('guard: enforceSlippageFloor is a stub — throws not implemented until built', () => {
  assert.throws(() => guard.enforceSlippageFloor(0n), /not implemented/);
});

test('guard: checkKillSwitch is a stub — throws not implemented until built', async () => {
  await assert.rejects(() => guard.checkKillSwitch('state/STOP', async () => false), /not implemented/);
});
