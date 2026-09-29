import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, AgentOutputError, runAnalyst, parseAnalystOutput, parseDeciderOutput, summarizeMemory } from '../src/agents/index.mjs';

// Placeholder scaffold test — replace with real coverage once src/agents is implemented.
// Every test must inject a fake spawnImpl; never actually spawn `claude -p` from `node --test`.

test('agents: ROLES is the frozen three-analyst contract', () => {
  assert.deepEqual(ROLES, ['momentumScout', 'riskAnalyst', 'portfolioManager']);
  assert.equal(Object.isFrozen(ROLES), true);
});

test('agents: AgentOutputError carries role and raw text', () => {
  const err = new AgentOutputError('momentumScout', 'not json');
  assert.equal(err.role, 'momentumScout');
  assert.equal(err.raw, 'not json');
});

test('agents: runAnalyst is a stub — throws not implemented until built (no real spawn)', async () => {
  const neverSpawn = () => { throw new Error('unit test tried to spawn a real process'); };
  await assert.rejects(
    () => runAnalyst('momentumScout', { market: [], holdings: [], memorySummary: '', profile: {} }, { spawnImpl: neverSpawn }),
    /not implemented/,
  );
});

test('agents: parseAnalystOutput / parseDeciderOutput / summarizeMemory are stubs', () => {
  assert.throws(() => parseAnalystOutput('momentumScout', '[]'), /not implemented/);
  assert.throws(() => parseDeciderOutput('{}'), /not implemented/);
  assert.throws(() => summarizeMemory([]), /not implemented/);
});
