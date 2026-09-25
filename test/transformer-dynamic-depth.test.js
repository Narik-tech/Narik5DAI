import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/transformer-search.js';
import { createPosition, validateAction } from '../src/rules.js';

const options = {
  maxDepth: 0, maxNodes: 200_000, timeMs: 10_000,
  evaluateBatch: async positions => positions.map(() => 0),
};

test('dynamic depth starts at one and preserves zero as the requested limit with no budget', async () => {
  for (const budget of [{ maxNodes: 0 }, { timeMs: 0 }]) {
    const result = await analyze(createPosition(), { ...options, ...budget });
    assert.equal(result.depthMode, 'dynamic');
    assert.equal(result.currentMaxDepth, 1);
    assert.equal(result.dynamicDepthThreshold, 20);
    assert.equal(result.limits.maxDepth, 0);
    assert.equal(result.depth, 0);
    assert.equal(result.evaluations, 0);
  }
});

test('dynamic depth evaluates twenty leading root moves before opening depth two', async () => {
  const reports = [];
  let stop = false;
  const result = await analyze(createPosition(), { ...options,
    onProgress: info => { reports.push(info); stop ||= info.currentMaxDepth === 2; },
    shouldStop: () => stop,
  });
  assert.equal(reports[0].currentMaxDepth, 1);
  assert.equal(result.currentMaxDepth, 2);
  assert.equal(result.rootActionsSearched, 20);
  assert.equal(result.depth, 1);
  assert.equal(result.selectiveDepth, 1);
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.depthStats.length, 1);
  assert.equal(result.depthStats[0].trueEvaluations, 20);
  assert.equal(result.depthStats[0].candidates, 0);
});

test('each dynamic ceiling waits for the leading twenty True evaluations at every searched depth', async () => {
  const transitions = [];
  let ceiling = 1, stop = false;
  const position = createPosition();
  const result = await analyze(position, { ...options,
    onProgress: info => {
      if (info.currentMaxDepth !== ceiling) {
        assert.equal(info.currentMaxDepth, ceiling + 1);
        assert.ok(info.depthStats.some(level => level.depth === ceiling));
        assert.ok(info.depthStats.every(level => level.searchedMoves === null || level.searchedMoves >= 20));
        assert.ok(info.depthStats.at(-1).trueEvaluations >= 20);
        ceiling = info.currentMaxDepth;
        transitions.push(ceiling);
      }
      stop ||= ceiling === 3;
    },
    shouldStop: () => stop,
  });
  assert.deepEqual(transitions, [2, 3]);
  assert.equal(result.limits.maxDepth, 0);
  assert.equal(result.currentMaxDepth, 3);
  assert.equal(result.depth, 2);
  assert.equal(result.stoppedReason, 'cancelled');
  let current = position;
  for (const action of result.pv) current = validateAction(current, action);
});

test('short exhausted frontiers advance one level at a time in dynamic mode', async () => {
  const transitions = [];
  let ceiling = 1, stop = false;
  const result = await analyze(createPosition(), { ...options, candidateLimit: 2, innerCandidateLimit: 2,
    onProgress: info => {
      if (info.currentMaxDepth !== ceiling) {
        assert.equal(info.currentMaxDepth, ceiling + 1);
        assert.equal(info.depth, ceiling);
        assert.equal(info.depthStats.at(-1).depth, ceiling);
        assert.ok(info.depthStats.every(level => level.candidates === 0));
        ceiling = info.currentMaxDepth;
        transitions.push(ceiling);
      }
      stop ||= ceiling === 5;
    },
    shouldStop: () => stop,
  });
  assert.deepEqual(transitions, [2, 3, 4, 5]);
  assert.equal(result.stoppedReason, 'cancelled');
});

test('a fixed depth of one remains fixed after its top twenty moves are evaluated', async () => {
  const result = await analyze(createPosition(), { ...options, maxDepth: 1 });
  assert.equal(result.depthMode, 'fixed');
  assert.equal(result.dynamicDepthThreshold, null);
  assert.equal(result.currentMaxDepth, 1);
  assert.equal(result.depth, 1);
  assert.equal(result.rootActionsSearched, 20);
  assert.equal(result.stoppedReason, 'depth');
});
