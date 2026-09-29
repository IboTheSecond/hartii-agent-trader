import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaperEngine, replayHistory, evalStrategy } from '../src/sim/index.mjs';

// Placeholder scaffold test — replace with real coverage once src/sim is implemented. The
// paper engine must simulate fills from injected quotes only — never reach the real API or
// chain from `node --test`.

test('sim: createPaperEngine methods are stubs — throw not implemented until built', async () => {
  const engine = createPaperEngine({ initialQuaiWei: 1000n, api: {} });
  await assert.rejects(() => engine.buy('0x00token', 100n, 1n), /not implemented/);
  assert.throws(() => engine.getState(), /not implemented/);
});

test('sim: replayHistory / evalStrategy are stubs — throw not implemented until built', async () => {
  await assert.rejects(
    () => replayHistory({ api: {}, tokenAddress: '0x00token', fromMs: 0, toMs: 1, strategyFn: () => null }),
    /not implemented/,
  );
  assert.throws(() => evalStrategy([]), /not implemented/);
});
