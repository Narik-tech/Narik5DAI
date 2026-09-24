import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { analyze } from '../src/parallel-search.js';
import { analyze as analyzeSerial, MATE_SCORE } from '../src/search.js';
import { applyMove, createPosition, generateActions, inCheck, raw, submitPosition, validateAction } from '../src/rules.js';

const promotions = [10, 9, 8, 7, 6, 5, 4, 3];
const limits = { timeMs: 20000, maxNodes: 500000, maxDepth: 2, quiescenceDepth: 1 };
const capturePosition = () => ({
  board: [[[[12, 0, 0, 0], [8, 0, 9, 0], [0, 0, 0, 0], [0, 0, 0, 11]]]],
  action: 0, promotions,
});

function validatePolicyPv(position, result) {
  let current = position;
  for (const action of result.pv) {
    validateAction(current, action);
    for (const move of action) {
      const [from, to] = move;
      if (from[0] === to[0] && from[1] === to[1]) {
        assert(raw.boardFuncs.present(current.board, current.action).includes(from[0]),
          'ordinary PV moves must start on a present board');
      }
      current = applyMove(current, move);
    }
    current = submitPosition(current);
  }
  return current;
}

function assertAccounting(result, maxNodes) {
  assert.equal(result.nodes, result.searchNodes + result.generationNodes);
  assert(result.nodes <= maxNodes, `global work budget exceeded: ${result.nodes} > ${maxNodes}`);
  assert(result.qnodes <= result.searchNodes);
  assert(result.qTtHits <= result.ttHits);
}

test('one thread preserves the serial search result and reports normalized thread limits', async () => {
  const position = capturePosition();
  const serial = analyzeSerial(position, limits);
  const result = await analyze(position, { ...limits, threads: 1 });
  for (const field of ['score', 'depth', 'completed', 'status', 'effectiveQuiescenceDepth', 'nodes']) {
    assert.equal(result[field], serial[field], field);
  }
  assert.deepEqual(result.bestAction, serial.bestAction);
  assert.deepEqual(result.pv, serial.pv);
  assert.equal(result.limits.threads, 1);
  for (const [threads, expected] of [[0, 1], [-5, 1], [2.9, 2], [30, 16]]) {
    const bounded = await analyze(position, { threads, maxNodes: 0 });
    assert.equal(bounded.limits.threads, expected);
    assert.equal(bounded.nodes, 0);
  }
});

test('two and four threads match completed tactical scores for either mover without changing the input', async () => {
  const white = capturePosition();
  const blackBoard = white.board[0][0].toReversed().map(row => row.map(piece => !piece ? 0 : piece % 2 ? piece + 1 : piece - 1));
  const black = { board: [[null, blackBoard]], action: 1, promotions };
  for (const position of [white, black]) {
    const original = structuredClone(position);
    const serial = analyzeSerial(position, limits);
    assert.equal(serial.depth, limits.maxDepth);
    for (const threads of [2, 4]) {
      const result = await analyze(position, { ...limits, threads });
      assert.equal(result.status, 'ok');
      assert.equal(result.completed, true);
      assert.equal(result.depth, serial.depth);
      assert.equal(result.effectiveQuiescenceDepth, serial.effectiveQuiescenceDepth);
      assert.equal(result.score, serial.score);
      assert.equal(result.limits.threads, threads);
      assert.equal(result.threadsUsed, threads);
      assert.deepEqual(result.bestAction, serial.bestAction, 'the hanging queen gives this fixture a unique best move');
      assert.deepEqual(position, original);
      assertAccounting(result, limits.maxNodes);
      validatePolicyPv(position, result);
    }
  }
});

test('parallel roots are complete multiboard turns and retain the serial depth-two score', async () => {
  const board = capturePosition().board[0][0];
  const position = { board: [[structuredClone(board)], null, [structuredClone(board)]], action: 0, promotions };
  const options = { ...limits, maxDepth: 2, quiescenceDepth: 0 };
  const serial = analyzeSerial(position, options);
  const result = await analyze(position, { ...options, threads: 2 });
  assert.equal(serial.depth, 2);
  assert.equal(result.depth, 2);
  assert.equal(result.threadsUsed, 2);
  assert.equal(result.score, serial.score);
  assert(result.bestAction.length >= 2);
  assert.equal(validateAction(position, result.bestAction).action, 1);
  validatePolicyPv(position, result);
  assertAccounting(result, options.maxNodes);
});

test('parallel quiescence searches recaptures at the requested horizon', async () => {
  const position = createPosition({ pgn: '1. e4 / e5 2. Nf3 / Nc6' });
  const options = { ...limits, maxDepth: 1, quiescenceDepth: 1 };
  const serial = analyzeSerial(position, options);
  const result = await analyze(position, { ...options, threads: 2 });
  assert.equal(result.depth, 1);
  assert.equal(result.effectiveQuiescenceDepth, 1);
  assert.equal(result.score, serial.score);
  assert.deepEqual(result.bestAction, serial.bestAction);
  assert(result.qnodes > 0);
  validatePolicyPv(position, result);
});

test('parallel roots and their continuations exclude optional spatial moves while allowing temporal moves', async () => {
  const board = capturePosition().board[0][0];
  const position = {
    board: [[structuredClone(board)], null,
      Array.from({ length: 3 }, () => structuredClone(board)), null, [structuredClone(board)]],
    action: 0, promotions,
  };
  const serial = analyzeSerial(position, limits);
  const result = await analyze(position, {
    ...limits, threads: 2,
    onProgress: progress => validatePolicyPv(position, progress),
  });
  assert.equal(result.depth, 2);
  assert.equal(result.score, serial.score);
  assert.equal(result.searchPolicy, 'present-spatial');
  validatePolicyPv(position, result);
});

test('parallel search retains root-relative mate distance including checked horizon evasions', async () => {
  const mateInOne = createPosition({ pgn: '1. e3 / f6 2. Qe2 / Nc6' });
  const win = await analyze(mateInOne, { ...limits, threads: 2 });
  assert.equal(win.score, MATE_SCORE - 1);
  assert.equal(win.scoreType, 'mate');
  assert.equal(win.mateIn, 1);
  assert.equal(win.stoppedReason, 'mate');
  const after = validateAction(mateInOne, win.bestAction);
  assert(inCheck(after));
  assert.deepEqual([...generateActions(after)], []);

  const checked = {
    board: [[[[5, 0, 0, 0], [10, 12, 0, 9], [11, 0, 0, 0], [0, 0, 0, 0]]]],
    action: 0, promotions,
  };
  const loss = await analyze(checked, { ...limits, maxDepth: 2, quiescenceDepth: 0, threads: 2 });
  assert.equal(loss.score, -MATE_SCORE + 2);
  assert.equal(loss.mateIn, -2);
  assert.equal(loss.threadsUsed, 2);
  assert.equal(loss.pv.length, 2);
  const end = validatePolicyPv(checked, loss);
  assert(inCheck(end));
  assert.deepEqual([...generateActions(end)], []);
});

test('terminal roots distinguish mate from stalemate with multiple threads requested', async () => {
  const mate = createPosition({ pgn: '1. e3 / f6 2. Qe2 / Nc6 3. Qh5' });
  const stalemate = { board: [[[[12, 0, 0], [0, 0, 11], [0, 9, 0]]]], action: 0, promotions };
  for (const [position, status, score] of [[mate, 'checkmate', MATE_SCORE], [stalemate, 'stalemate', 0]]) {
    const result = await analyze(position, { ...limits, threads: 4 });
    assert.equal(result.status, status);
    assert.equal(result.score, score);
    assert.equal(result.completed, true);
    assert.equal(result.bestAction, null);
    assert.deepEqual(result.pv, []);
    assertAccounting(result, limits.maxNodes);
  }
});

test('an empty selected policy never becomes a fabricated terminal result or an excluded fallback', async () => {
  const future = [[0, 8, 0], [11, 0, 0], [4, 0, 12]];
  const position = {
    board: [[[[0, 11, 12], [7, 0, 0], [3, 0, 0]]], null,
      Array.from({ length: 3 }, () => structuredClone(future))],
    action: 0, promotions,
  };
  const result = await analyze(position, { ...limits, threads: 2 });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.completed, false);
  assert.equal(result.stoppedReason, 'policy');
  assert.equal(result.policyLeaves, 1);
  assert.equal(result.searchPolicy, 'present-spatial');
  assert.equal(result.score, null);
  assert.equal(result.scoreType, 'unavailable');
  assert.equal(result.mateIn, null);
  assert.equal(result.bestAction, null);
  assert.deepEqual(result.pv, []);
});

test('all threads share a strict work budget including action generation', async () => {
  const position = createPosition();
  for (const maxNodes of [0, 1, 3, 100]) {
    const result = await analyze(position, { ...limits, maxDepth: 8, threads: 4, maxNodes });
    assertAccounting(result, maxNodes);
    assert.equal(result.nodes, maxNodes);
    assert.equal(result.stoppedReason, 'nodes');
    if (result.bestAction) validatePolicyPv(position, result);
    if (maxNodes === 0) {
      assert.equal(result.status, 'incomplete');
      assert.equal(result.completed, false);
      assert.equal(result.score, null);
      assert.equal(result.bestAction, null);
    }
    if (maxNodes === 3) {
      assert(result.bestAction);
      assert.equal(result.score, null);
    }
  }
  for (const maxNodes of [150, 250, 500]) {
    const result = await analyze(capturePosition(), { ...limits, maxDepth: 8, threads: 4, maxNodes });
    assert.equal(result.threadsUsed, 4, 'budget must reach the parallel part of search');
    assertAccounting(result, maxNodes);
    assert.equal(result.nodes, maxNodes);
    assert.equal(result.stoppedReason, 'nodes');
    validatePolicyPv(capturePosition(), result);
  }
});

test('cancellation retains the last completed iteration and its exact quiescence horizon', async () => {
  const position = capturePosition();
  let stopped = false, completedIteration;
  const result = await analyze(position, {
    ...limits, maxDepth: 8, quiescenceDepth: 2, threads: 2,
    shouldStop: () => stopped,
    onProgress(progress) {
      if (progress.completed && !completedIteration) {
        completedIteration = structuredClone(progress);
        stopped = true;
      }
    },
  });
  assert(completedIteration);
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.completed, true);
  assert.equal(result.depth, 1);
  assert.equal(result.effectiveQuiescenceDepth, 0);
  assert.equal(result.score, completedIteration.score);
  assert.deepEqual(result.bestAction, completedIteration.bestAction);
  assert.deepEqual(result.pv, completedIteration.pv);
  validatePolicyPv(position, result);
});

test('cancellation from the event loop stops an active worker pool and preserves the completed result', async () => {
  const position = capturePosition();
  let stopped = false, completedIteration, timer;
  try {
    const result = await analyze(position, {
      ...limits, maxDepth: 16, quiescenceDepth: 0, threads: 4,
      shouldStop: () => stopped,
      onProgress(progress) {
        if (progress.completed) {
          completedIteration = structuredClone(progress);
          if (!timer) timer = setTimeout(() => { stopped = true; }, 0);
        }
      },
    });
    assert.equal(result.threadsUsed, 4);
    assert.equal(result.stoppedReason, 'cancelled');
    assert.equal(result.completed, true);
    assert.equal(result.depth, completedIteration.depth);
    assert.equal(result.score, completedIteration.score);
    assert.deepEqual(result.pv, completedIteration.pv);
    assertAccounting(result, limits.maxNodes);
  } finally {
    clearTimeout(timer);
  }
});

test('wall-clock stop includes worker startup and returns promptly', async () => {
  const position = createPosition();
  const before = performance.now();
  let activeSnapshots = 0;
  const result = await analyze(position, {
    timeMs: 1000, maxDepth: 64, quiescenceDepth: 0, maxNodes: 1000000000, threads: 4,
    onProgress(progress) {
      assertAccounting(progress, 1000000000);
      if (progress.threadsUsed === 4 && progress.searchingDepth > progress.depth) activeSnapshots++;
    },
  });
  // Startup and cleanup vary on shared CI machines; the search must still
  // return promptly instead of granting each worker a fresh time allowance.
  assert(performance.now() - before < 5000);
  assert.equal(result.stoppedReason, 'time');
  assert.equal(result.threadsUsed, 4);
  assert(activeSnapshots > 0, 'live progress must include work from the running pool');
  assertAccounting(result, 1000000000);
  if (result.bestAction) validatePolicyPv(position, result);
});

test('cache byte and entry budgets cap the combined pool and every published snapshot', async () => {
  const position = capturePosition();
  const options = { ...limits, threads: 4 };
  const serial = analyzeSerial(position, { ...limits, cacheMemoryMb: 0 });
  for (const [cacheMemoryMb, maxTableEntries] of [[0, 100000], [1, 0], [0.001, 3], [1, 1000]]) {
    const snapshots = [];
    const result = await analyze(position, {
      ...options, cacheMemoryMb, maxTableEntries,
      onProgress: progress => snapshots.push(progress),
    });
    assert.equal(result.depth, serial.depth);
    assert.equal(result.score, serial.score);
    assert.equal(result.threadsUsed, 4);
    validatePolicyPv(position, result);
    for (const snapshot of [...snapshots, result]) {
      assert.equal(snapshot.limits.cacheMemoryMb, cacheMemoryMb);
      assert.equal(snapshot.limits.maxTableEntries, maxTableEntries);
      assert(snapshot.cacheMemoryBytes >= 0);
      assert(snapshot.cacheMemoryBytes <= Math.floor(cacheMemoryMb * 1024 * 1024));
      assert(snapshot.tableEntries <= maxTableEntries);
      if (!cacheMemoryMb || !maxTableEntries) {
        assert.equal(snapshot.tableEntries, 0);
        assert.equal(snapshot.cacheMemoryBytes, 0);
      }
    }
  }
});

test('a synchronous worker posting failure rejects promptly and closes the worker', { timeout: 5000 }, async () => {
  const originalPostMessage = Worker.prototype.postMessage;
  const failure = new Error('Injected worker posting failure');
  let failedWorker;
  Worker.prototype.postMessage = function (message, ...args) {
    if (message?.request) {
      failedWorker = this;
      throw failure;
    }
    return originalPostMessage.call(this, message, ...args);
  };
  const before = performance.now();
  try {
    await assert.rejects(analyze(capturePosition(), { ...limits, threads: 2 }), error => error === failure);
    assert(failedWorker, 'the fixture must dispatch a parallel root candidate');
    assert.equal(failedWorker.threadId, -1, 'rejection must wait for worker termination');
    assert(performance.now() - before < 3000);
  } finally {
    Worker.prototype.postMessage = originalPostMessage;
    await failedWorker?.terminate();
  }
});

test('progress callback errors reject analysis and close a running worker pool', { timeout: 5000 }, async () => {
  const failure = new Error('Injected progress callback failure');
  let activeProgress = false;
  await assert.rejects(analyze(createPosition(), {
    timeMs: 3000, maxDepth: 64, quiescenceDepth: 0, maxNodes: 1000000000, threads: 4,
    onProgress(progress) {
      if (progress.threadsUsed === 4 && progress.searchingDepth > progress.depth) {
        activeProgress = true;
        throw failure;
      }
    },
  }), error => error === failure);
  assert(activeProgress, 'the callback failure must happen after workers start');
});
