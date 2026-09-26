import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/transformer-search.js';
import { canSubmit, createPosition, generateActions, positionKey, raw, validateAction } from '../src/rules.js';

const limits = { timeMs: 10000, maxNodes: 100000, maxDepth: 1, candidateLimit: 256 };
const board = () => [[12, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 11]];
const timeline = length => Array.from({ length }, board);
const position = (action, timelines) => ({ board: timelines, action, promotions: [10, 9, 8, 7, 6, 5, 4, 3] });

function requiredActions(start) {
  return [...generateActions(start, { orderMoves: (current, moves) => {
    const present = raw.boardFuncs.present(current.board, current.action);
    return moves.filter(move => present.includes(move[0][0]));
  } })];
}

function assertIncomplete(start, result, reason = 'cancelled') {
  assert.equal(result.stoppedReason, reason);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.completed, false);
  assert.equal(result.depth, 0);
  assert.equal(result.rootActionsSearched, 0, 'the interruption must occur while assembling root candidates');
  assert.deepEqual(result.pv, [result.bestAction]);
  const submitted = validateAction(start, result.bestAction);
  assert.equal(submitted.action, start.action + 1);
  return submitted;
}

for (const [color, action, side] of [['White', 0, 1], ['Black', 1, -1]]) {
  test(`${color} retains a scored root submission when cancelled before its first candidate is admitted`, async t => {
    const start = createPosition(action ? { pgn: '1. e4' } : {});
    let now = 0, stop = false, wanted;
    t.mock.method(performance, 'now', () => now += 101);
    // Progress observes accepted inference before the traversal reaches its
    // first submission. Cancellation must keep the best complete batch value.
    const result = await analyze(start, { ...limits, unlimitedTime: true, componentBatchSize: 4,
      shouldStop: () => stop,
      onProgress(snapshot) {
        if (snapshot.evaluations) {
          assert.equal(snapshot.rankings.length, 0);
          stop = true;
        }
      },
      evaluateBatch: async positions => {
        wanted = positionKey(positions.at(-1));
        return positions.map(pos => side * (positionKey(pos) === wanted ? 750 : 100));
      },
    });
    assert.equal(stop, true);
    assert.equal(result.evaluations, 4);
    assert.equal(result.inferenceBatches, 1);
    assert.equal(result.rankings.length, 0);
    assert.equal(positionKey(assertIncomplete(start, result)), wanted);
    assert.equal(result.score, side * 750);
    assert.equal(result.scoreType, 'cp');
  });

  test(`${color} retains earlier full-turn scores when the next incremental batch exceeds its deadline`, async t => {
    const start = createPosition(action ? { pgn: '1. e4' } : {});
    const first = generateActions(start).next().value;
    let now = 0, batches = 0, wanted;
    t.mock.method(performance, 'now', () => now);
    const result = await analyze(start, { ...limits, componentBatchSize: 3, initialCandidates: 8,
      evaluateBatch: async positions => {
        batches++;
        for (const pos of positions) assert.equal(pos.action, action + 1);
        if (batches === 1) {
          assert.equal(positions.length, 3);
          wanted = positionKey(positions.at(-1));
          return positions.map(pos => side * (positionKey(pos) === wanted ? 750 : 100));
        }
        now = limits.timeMs + 1;
        return positions.map(() => side * 90000);
      },
    });
    assert.equal(batches, 2);
    assert.equal(result.evaluations, 3, 'the expired batch must be discarded');
    assert.equal(result.rankings[0].total, 3, 'earlier candidates are admitted before more inference');
    assert.notEqual(wanted, positionKey(first.position));
    assert.equal(positionKey(assertIncomplete(start, result, 'time')), wanted);
    assert.equal(result.score, side * 750);
    assert.equal(result.scoreType, 'cp');
    assert.equal(result.mateProven, false);
  });

  test(`${color} retains the best required submission when temporal optional admission is cancelled`, async () => {
    const start = position(action, [timeline(action + 1), null, timeline(action + 3)]);
    const first = generateActions(start).next().value;
    const required = requiredActions(start), favorite = required.at(-1);
    assert(required.length > 1);
    assert.notDeepEqual(favorite.moves, first.moves, 'the chosen move must differ from the raw fallback');
    const wanted = positionKey(favorite.position);
    const requiredKeys = new Set(required.map(candidate => positionKey(candidate.position)));
    let optionalBatchSeen = false, stop = false;
    const result = await analyze(start, { ...limits, initialCandidates: 64, shouldStop: () => stop,
      evaluateBatch: async positions => {
        if (positions.some(pos => !requiredKeys.has(positionKey(pos)))) {
          optionalBatchSeen = true;
          stop = true;
        }
        return positions.map(pos => side * (positionKey(pos) === wanted ? 750 : 100));
      },
    });
    assert.equal(optionalBatchSeen, true);
    assert.equal(positionKey(assertIncomplete(start, result)), wanted);
    assert.deepEqual(result.bestAction, favorite.moves);
    assert.equal(result.score, side * 750);
    assert.equal(result.scoreType, 'cp');
    assert.equal(result.mateProven, false);
  });

  test(`${color} improves a multi-board fallback using submitted scores, never incomplete component scores`, async () => {
    const start = position(action, Array.from({ length: 3 }, () => timeline(action + 1)));
    let stop = false, completedBatches = 0, incompleteEvaluations = 0, wanted;
    const result = await analyze(start, { ...limits, initialCandidates: 64, componentBatchSize: 2, shouldStop: () => stop,
      evaluateBatch: async positions => {
        // Cancel the first later batch after two groups of complete turns have
        // been scored and yielded. No wall-clock timing controls interruption.
        if (completedBatches === 2) stop = true;
        const submitted = positions.filter(pos => pos.action === action + 1);
        if (!stop && submitted.length) {
          completedBatches++;
          if (completedBatches === 2) wanted = positionKey(submitted.at(-1));
        }
        return positions.map(pos => {
          if (pos.action === action) {
            assert.equal(canSubmit(pos), false);
            incompleteEvaluations++;
            return side * 90000;
          }
          return side * (positionKey(pos) === wanted ? 750 : 250);
        });
      },
    });
    assert.equal(completedBatches, 2);
    assert(incompleteEvaluations > 0, 'the fixture must evaluate incomplete turns with stronger component scores');
    assert.equal(positionKey(assertIncomplete(start, result)), wanted);
    assert(result.bestAction.length >= 2, 'the scored fallback must be a complete compound turn');
    assert.equal(result.score, side * 750);
    assert.equal(result.scoreType, 'cp');
    assert.equal(result.mateProven, false);
  });

  test(`${color} keeps an unscored legal fallback when only incomplete components were evaluated`, async () => {
    const start = position(action, Array.from({ length: 3 }, () => timeline(action + 1)));
    const first = generateActions(start).next().value;
    let batches = 0, acceptedEvaluations = 0, stop = false;
    const result = await analyze(start, { ...limits, shouldStop: () => stop,
      evaluateBatch: async positions => {
        if (++batches === 2) stop = true;
        if (!stop) {
          for (const pos of positions) {
            assert.equal(pos.action, action);
            assert.equal(canSubmit(pos), false);
          }
          acceptedEvaluations += positions.length;
        }
        return positions.map(() => side * 90000);
      },
    });
    assert.equal(batches, 2);
    assert(acceptedEvaluations > 0);
    assert.equal(result.evaluations, acceptedEvaluations);
    assertIncomplete(start, result);
    assert.deepEqual(result.bestAction, first.moves);
    assert.equal(result.score, null);
    assert.equal(result.scoreType, 'unavailable');
    assert.equal(result.mateProven, false);
  });

  test(`${color} retains the backed reply score when cancelled after a True evaluation`, async t => {
    const start = createPosition(action ? { pgn: '1. e4' } : {});
    let now = 0, stop = false, lastBacked;
    t.mock.method(performance, 'now', () => now += 101);
    const result = await analyze(start, { ...limits, unlimitedTime: true,
      maxDepth: 3, candidateLimit: 1, innerCandidateLimit: 1,
      initialCandidates: 1, componentBatchSize: 1, tacticalExtensionDepth: 0,
      shouldStop: () => stop,
      evaluateBatch: async positions => positions.map(pos => side * (pos.action === action + 1 ? 500 : -250)),
      onProgress(snapshot) {
        if (snapshot.depth === 2) {
          lastBacked = snapshot;
          stop = true;
        }
      },
    });
    assert(lastBacked);
    assert.equal(result.stoppedReason, 'cancelled');
    assert.equal(result.status, 'ok');
    assert.equal(result.completed, true);
    assert.equal(result.depth, 2);
    assert.equal(result.score, side * -250, 'the reply replaces the earlier root value of 500');
    assert.equal(result.score, lastBacked.score);
    assert.deepEqual(result.pv, lastBacked.pv);
    assert.equal(result.pv.length, 2);
    let current = start;
    for (const moves of result.pv) current = validateAction(current, moves);
    assert.equal(current.action, action + 2);
  });
}
