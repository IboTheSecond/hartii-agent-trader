import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_ALLOWLISTS, buildReadOnlyTools, buildTradeTools, createMcpServer } from '../src/tools/index.mjs';

// Placeholder scaffold test — replace with real coverage once src/tools is implemented.

test('tools: TOOL_ALLOWLISTS has exactly the frozen roles from INTERFACES.md, no NFT tool', () => {
  assert.deepEqual(Object.keys(TOOL_ALLOWLISTS).sort(), ['decider', 'momentumScout', 'portfolioManager', 'riskAnalyst']);
  for (const list of Object.values(TOOL_ALLOWLISTS)) {
    assert.equal(Object.isFrozen(list), true);
    assert.ok(!list.some((name) => /nft/i.test(name)), 'no allowlist may ever include an NFT-deploy tool');
  }
});

test('tools: buildReadOnlyTools is a stub — throws not implemented until built', () => {
  assert.throws(() => buildReadOnlyTools({}), /not implemented/);
});

test('tools: buildTradeTools is a stub — throws not implemented until built', () => {
  assert.throws(() => buildTradeTools({}), /not implemented/);
});

test('tools: createMcpServer is a stub — throws not implemented until built', () => {
  assert.throws(() => createMcpServer([], { name: 'test' }), /not implemented/);
});
