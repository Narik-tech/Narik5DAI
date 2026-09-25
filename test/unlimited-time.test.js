import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze as serialAnalyze } from '../src/search.js';
import { analyze as parallelAnalyze } from '../src/parallel-search.js';
import { analyze as transformerAnalyze } from '../src/transformer-search.js';
import { validateAction } from '../src/rules.js';

const capturePosition = () => ({
  board: [[[[12, 0, 0, 0], [8, 0, 9, 0], [0, 0, 0, 0], [0, 0, 0, 11]]]],
  action: 0, promotions: [10, 9, 8, 7, 6, 5, 4, 3],
});
const engines = [
  { name: 'serial', analyze: serialAnalyze, options: { quiescenceDepth: 0 } },
  { name: 'parallel', analyze: parallelAnalyze, options: { quiescenceDepth: 0, threads: 2 } },
  { name: 'transformer', analyze: transformerAnalyze, options: {
    candidateLimit: 1, evaluateBatch: async positions => positions.map(() => 0),
  } },
];

for (const engine of engines) {
  test(`${engine.name} unlimited time survives clock advances and still stops at depth`, async t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now += 3_600_001);
    const position = capturePosition();
    const result = await engine.analyze(position, {
      ...engine.options, timeMs: 0, unlimitedTime: true, maxDepth: 2, maxNodes: 500000,
      onProgress: progress => assert.equal(progress.limits.timeMs, 0),
    });
    assert.equal(result.limits.timeMs, 0);
    assert.equal(result.stoppedReason, 'depth');
    assert.equal(result.depth, 2);
    assert.equal(result.completed, true);
    assert(result.elapsedMs > 3_600_000);
    if (engine.name === 'parallel') assert.equal(result.threadsUsed, 2);
    let current = position;
    for (const action of result.pv) current = validateAction(current, action);
  });

  test(`${engine.name} unlimited time still honors node limits and cancellation`, async () => {
    const options = { ...engine.options, timeMs: 0, unlimitedTime: true, maxDepth: 8 };
    const bounded = await engine.analyze(capturePosition(), { ...options, maxNodes: 3 });
    assert.equal(bounded.stoppedReason, 'nodes');
    assert.equal(bounded.nodes, 3);
    let stop = false;
    const cancelled = await engine.analyze(capturePosition(), {
      ...options, shouldStop: () => stop,
      onProgress: progress => { if (progress.completed) stop = true; },
    });
    assert.equal(cancelled.stoppedReason, 'cancelled');
    assert.equal(cancelled.depth, 1);
    assert.equal(cancelled.completed, true);
  });

  test(`${engine.name} zero time without explicit unlimited mode remains expired`, async () => {
    for (const unlimitedTime of [undefined, false, 'true']) {
      const result = await engine.analyze(capturePosition(), { ...engine.options, timeMs: 0, unlimitedTime });
      assert.equal(result.stoppedReason, 'time');
      assert.equal(result.nodes, 0);
      assert.equal(result.completed, false);
      assert.equal(result.bestAction, null);
    }
  });
}

test('unlimited transformer time remains cancellable while inference is stalled', { timeout: 2000 }, async () => {
  let stop = false, timer;
  try {
    const result = await transformerAnalyze(capturePosition(), {
      timeMs: 0, unlimitedTime: true, candidateLimit: 1,
      shouldStop: () => stop,
      evaluateBatch: () => {
        timer = setTimeout(() => { stop = true; }, 0);
        return new Promise(() => {});
      },
    });
    assert.equal(result.stoppedReason, 'cancelled');
    assert.equal(result.score, null);
    assert.equal(result.completed, false);
  } finally { clearTimeout(timer); }
});
